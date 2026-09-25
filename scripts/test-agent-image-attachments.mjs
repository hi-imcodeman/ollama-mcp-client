import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  plugins: [
    {
      name: 'mock-electron-for-agent-harness',
      enforce: 'pre',
      resolveId(source) {
        return source === 'electron' ? '\0electron-agent-test' : undefined
      },
      load(id) {
        return id === '\0electron-agent-test'
          ? "export const BrowserWindow = { getAllWindows: () => [] }; export const app = { getPath: () => '/tmp/ollama-mcp-agent-test' }"
          : undefined
      }
    }
  ],
  ssr: { noExternal: ['electron'] }
})

const {
  prepareEditImageToolArguments,
  prepareGenerateImageToolArguments,
  selectEditImageSources
} =
  await server.ssrLoadModule(
  new URL('../src/main/agent-image-boundary.ts', import.meta.url).pathname
)
const { buildAgentImageTools } = await server.ssrLoadModule(
  new URL('../src/main/agent-tool-boundary.ts', import.meta.url).pathname
)
const { runAgentTurn } = await server.ssrLoadModule(
  new URL('../src/main/agent.ts', import.meta.url).pathname
)
const { onChatEvent } = await server.ssrLoadModule(
  new URL('../src/main/chat-events.ts', import.meta.url).pathname
)
const {
  setDefaultImageModel,
  setOpenaiApiKey,
  setOpenaiModelEnabled,
  setOpenaiModelsCatalog,
  setOllamaBaseUrl,
  setSelectedModelForProvider,
  setLlmProvider
} = await server.ssrLoadModule(
  new URL('../src/main/config-store.ts', import.meta.url).pathname
)

after(() => server.close())

test('passes only latest user-turn attachments through the production boundary', () => {
  const result = prepareGenerateImageToolArguments(
    [
      { role: 'user', content: 'earlier turn', images: ['earlier-image'] },
      { role: 'assistant', content: 'earlier response' },
      {
        role: 'user',
        content: 'combine these',
        images: ['current-image', 'second-current-image']
      }
    ],
    { prompt: 'combine these', images: ['model-image', 'current-image'] },
  )

  assert.deepEqual(result, {
    prompt: 'combine these',
    images: ['current-image', 'second-current-image']
  })
})

test('ignores malformed model images when current attachments exist', () => {
  const result = prepareGenerateImageToolArguments(
    [
      { role: 'user', content: 'earlier turn', images: ['earlier-image'] },
      { role: 'assistant', content: 'earlier response' },
      { role: 'user', content: 'edit this', images: ['first-current-image', 'second-current-image'] }
    ],
    { prompt: 'edit this', images: [null, 'not-valid-image-data'] },
  )

  assert.deepEqual(result, {
    prompt: 'edit this',
    images: ['first-current-image', 'second-current-image']
  })
})

test('exposes both image tools at the agent boundary', () => {
  const tools = buildAgentImageTools([])
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ['generate_image', 'edit_image']
  )
})

test('passes current attachments as internal edit sources', () => {
  const result = prepareEditImageToolArguments([
    { role: 'user', content: 'earlier', images: ['old-image'] },
    { role: 'assistant', content: 'response' },
    { role: 'user', content: 'edit this', images: ['current-image'] }
  ])

  assert.deepEqual(result, ['current-image'])
})

test('current uploads override the latest generated image', () => {
  assert.deepEqual(
    selectEditImageSources(
      [{ role: 'user', content: 'edit', images: ['a', 'b', 'a'] }],
      'generated'
    ),
    ['a', 'b']
  )
})

test('uses the latest generated image when the current turn has no uploads', () => {
  assert.deepEqual(
    selectEditImageSources([{ role: 'user', content: 'edit' }], 'generated'),
    ['generated']
  )
})

test('returns no sources when neither uploads nor generated image exists', () => {
  assert.deepEqual(
    selectEditImageSources([{ role: 'user', content: 'edit' }]),
    []
  )
})

test('excludes uploads from earlier turns', () => {
  assert.deepEqual(
    selectEditImageSources(
      [
        { role: 'user', content: 'earlier', images: ['old'] },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'follow-up' }
      ],
      'generated'
    ),
    ['generated']
  )
})

test('a repeated edit can use its previous output as the latest source', () => {
  const firstEdit = selectEditImageSources(
    [{ role: 'user', content: 'first edit' }],
    'generated'
  )
  const secondEdit = selectEditImageSources(
    [{ role: 'user', content: 'second edit' }],
    'edited-output'
  )
  assert.deepEqual(firstEdit, ['generated'])
  assert.deepEqual(secondEdit, ['edited-output'])
})

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
    async text() {
      return JSON.stringify(body)
    }
  }
}

function mockChatResponse(toolName) {
  const payload = JSON.stringify({
    message: {
      role: 'assistant',
      tool_calls: [{ function: { name: toolName, arguments: { prompt: 'make it blue' } } }]
    },
    done: true,
    prompt_eval_count: 3,
    eval_count: 2
  })
  const bytes = new TextEncoder().encode(`${payload}\n`)
  return {
    ...mockResponse(null),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      }
    })
  }
}

test('dispatches generation without sources and editing with selected sources', async () => {
  setLlmProvider('ollama')
  setSelectedModelForProvider('ollama', 'llama3.2-vision')
  setOllamaBaseUrl('http://mock-ollama')
  setOpenaiApiKey('test-key')
  setOpenaiModelsCatalog([{ id: 'gpt-image-1', name: 'gpt-image-1' }])
  setOpenaiModelEnabled('gpt-image-1', true)
  setDefaultImageModel('gpt-image-1')

  const originalFetch = globalThis.fetch
  const requests = []
  let nextTool = 'generate_image'
  globalThis.fetch = async (...args) => {
    const url = String(args[0])
    requests.push(args)
    if (url.endsWith('/api/version')) return mockResponse({ version: '0.1.0' })
    if (url.endsWith('/api/tags')) return mockResponse({ models: [] })
    if (url.endsWith('/api/show')) {
      return mockResponse({ capabilities: ['completion', 'vision'] })
    }
    if (url.endsWith('/api/chat')) return mockChatResponse(nextTool)
    if (url.endsWith('/images/generations')) {
      return mockResponse({ data: [{ b64_json: 'generated-image' }] })
    }
    if (url.endsWith('/images/edits')) {
      return mockResponse({ data: [{ b64_json: 'edited-image' }] })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  const events = []
  const unsubscribe = onChatEvent((event) => events.push(event))
  const basePayload = {
    model: 'llama3.2-vision',
    sessionId: 'task-4-session',
    messages: [
      {
        role: 'user',
        content: 'make an image',
        images: [Buffer.alloc(40, 7).toString('base64')]
      }
    ]
  }

  try {
    await runAgentTurn({ ...basePayload, turnId: 'task-4-generate' })
    const imageRequest = requests.find(([url]) => String(url).endsWith('/images/generations'))
    assert.ok(imageRequest)
    assert.equal(JSON.parse(imageRequest[1].body).images, undefined)
    assert.equal(events.filter((event) => event.type === 'assistant_images').length, 1)
    assert.equal(events.at(-1).type, 'done')

    events.length = 0
    requests.length = 0
    nextTool = 'edit_image'
    await runAgentTurn({
      ...basePayload,
      turnId: 'task-4-edit',
      messages: [{ ...basePayload.messages[0], content: 'edit this image' }]
    })
    const editRequest = requests.find(([url]) => String(url).endsWith('/images/edits'))
    assert.ok(editRequest)
    assert.equal(editRequest[1].body.getAll('image').length, 1)
    assert.equal(events.filter((event) => event.type === 'assistant_images').length, 1)
    assert.equal(events.find((event) => event.type === 'tool_start').name, 'edit_image')
    assert.equal(events.find((event) => event.type === 'tool_result').ok, true)
    assert.equal(events.at(-1).type, 'done')
  } finally {
    unsubscribe()
    globalThis.fetch = originalFetch
  }
})
