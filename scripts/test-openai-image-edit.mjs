import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom'
})
const { editOpenAiImageBase64 } = await server.ssrLoadModule(
  new URL('../src/main/openai-image.ts', import.meta.url).pathname
)
const { setOpenaiApiKey } = await server.ssrLoadModule(
  new URL('../src/main/config-store.ts', import.meta.url).pathname
)
after(() => server.close())

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

test('sends one image as a multipart OpenAI edit request', async () => {
  setOpenaiApiKey('test-key')
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    calls.push(args)
    return mockResponse({
      data: [{ b64_json: 'edited-image' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    })
  }

  try {
    const result = await editOpenAiImageBase64('gpt-image-1', 'make it blue', ['aW1hZ2U='])
    assert.equal(result.b64, 'edited-image')
    assert.deepEqual(result.usage, {
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      cachedPromptTokens: 0,
      reasoningTokens: 0
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'https://api.openai.com/v1/images/edits')
    const request = calls[0][1]
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.Authorization, 'Bearer test-key')
    assert.ok(request.body instanceof FormData)
    assert.equal(request.body.get('model'), 'gpt-image-1')
    assert.equal(request.body.get('prompt'), 'make it blue')
    assert.equal(request.body.get('n'), '1')
    assert.equal(request.body.getAll('image').length, 1)
    const image = request.body.get('image')
    assert.equal(image.type, 'image/png')
    assert.equal(image.name, 'image.png')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sends multiple source images as ordered multipart image parts', async () => {
  setOpenaiApiKey('test-key')
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (...args) => {
    request = args[1]
    return mockResponse({ data: [{ b64_json: 'combined-image' }] })
  }

  try {
    const result = await editOpenAiImageBase64('gpt-image-1', 'combine them', [
      'Zmlyc3Q=',
      'c2Vjb25k'
    ])
    assert.equal(result.b64, 'combined-image')
    const images = request.body.getAll('image')
    assert.equal(images.length, 2)
    assert.deepEqual(images.map((image) => [image.type, image.name]), [
      ['image/png', 'image.png'],
      ['image/png', 'image.png']
    ])
    assert.deepEqual(
      await Promise.all(images.map((image) => image.arrayBuffer().then((bytes) => Buffer.from(bytes).toString()))),
      ['first', 'second']
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preserves source MIME metadata and data URLs for multipart uploads', async () => {
  setOpenaiApiKey('test-key')
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (...args) => {
    request = args[1]
    return mockResponse({ data: [{ b64_json: 'edited-image' }] })
  }

  try {
    await editOpenAiImageBase64('gpt-image-1', 'edit', [
      { base64: 'data:image/jpeg;base64,aW1hZ2U=', mime: 'image/jpeg' }
    ])
    const image = request.body.get('image')
    assert.equal(image.type, 'image/jpeg')
    assert.equal(image.name, 'image.jpg')
    assert.equal(Buffer.from(await image.arrayBuffer()).toString(), 'image')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('accepts valid unpadded base64 payloads', async () => {
  setOpenaiApiKey('test-key')
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (...args) => {
    request = args[1]
    return mockResponse({ data: [{ b64_json: 'edited-image' }] })
  }

  try {
    const result = await editOpenAiImageBase64('gpt-image-1', 'edit', ['c2Vjb25k'])
    assert.equal(result.b64, 'edited-image')
    const image = request.body.get('image')
    assert.equal(Buffer.from(await image.arrayBuffer()).toString(), 'second')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('formats edit API errors and forwards abort signals', async () => {
  setOpenaiApiKey('test-key')
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  let request
  globalThis.fetch = async (...args) => {
    request = args[1]
    return mockResponse({ error: { message: 'edit rejected' } }, 400)
  }

  try {
    await assert.rejects(
      editOpenAiImageBase64('gpt-image-1', 'edit', ['aW1hZ2U='], controller.signal),
      /edit rejected/
    )
    assert.equal(request.signal, controller.signal)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects malformed raw base64 before uploading an image', async () => {
  setOpenaiApiKey('test-key')
  const originalFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = async (...args) => {
    fetchCalled = true
    return mockResponse({ data: [{ b64_json: 'unexpected' }] })
  }

  try {
    await assert.rejects(
      editOpenAiImageBase64('gpt-image-1', 'edit', ['not-valid-base64']),
      /valid base64/
    )
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
