import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom'
})

const {
  generateImageToolDefinition,
  runGenerateImageTool,
  shouldOfferGenerateImageTool
} =
  await server.ssrLoadModule(
    new URL('../src/main/image-gen-tool.ts', import.meta.url).pathname
  )
const {
  setDefaultImageModel,
  setOpenaiApiKey,
  setOpenaiModelEnabled,
  setOpenaiModelsCatalog
} = await server.ssrLoadModule(
  new URL('../src/main/config-store.ts', import.meta.url).pathname
)
after(() => server.close())

function response(body, status = 200) {
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

test('defines an optional images array while keeping prompt required', () => {
  const parameters = generateImageToolDefinition().function.parameters
  assert.deepEqual(parameters.required, ['prompt'])
  assert.deepEqual(parameters.properties.images, {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional source images as base64 payloads for editing'
  })
})

test('routes deduplicated source images to OpenAI editing', async () => {
  setOpenaiApiKey('test-key')
  setOpenaiModelsCatalog([{ id: 'gpt-image-1', name: 'gpt-image-1' }])
  setOpenaiModelEnabled('gpt-image-1', true)
  setDefaultImageModel('gpt-image-1')
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (...args) => {
    calls.push(args)
    if (String(args[0]).endsWith('/api/tags')) return response({}, 500)
    return response({ data: [{ b64_json: 'edited-image' }] })
  }

  try {
    const result = await runGenerateImageTool('openai', {
      prompt: 'remove the background',
      images: ['Zmlyc3Q=', 'c2Vjb25k', 'Zmlyc3Q=']
    })
    assert.deepEqual(result, {
      ok: true,
      model: 'gpt-image-1',
      imageBase64: 'edited-image',
      message: 'Generated image with gpt-image-1 via openai'
    })
    const request = calls.at(-1)[1]
    assert.equal(request.body.get('model'), 'gpt-image-1')
    assert.equal(request.body.get('prompt'), 'remove the background')
    const images = request.body.getAll('image')
    assert.equal(images.length, 2)
    assert.deepEqual(
      await Promise.all(
        images.map((image) =>
          image.arrayBuffer().then((bytes) => Buffer.from(bytes).toString())
        )
      ),
      ['first', 'second']
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects invalid image arguments with a clear failure', async () => {
  for (const images of [null, 'not-an-array', ['']]) {
    const result = await runGenerateImageTool('openai', {
      prompt: 'edit this',
      images
    })
    assert.deepEqual(result, {
      ok: false,
      message: 'Source images must be non-empty strings'
    })
  }
})

test('does not fall back to the other provider when the configured model is stale', async () => {
  setOpenaiModelsCatalog([{ id: 'gpt-image-1', name: 'gpt-image-1' }])
  setOpenaiModelEnabled('gpt-image-1', true)
  setDefaultImageModel('missing-image-model')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    const url = String(args[0])
    if (url.endsWith('/api/tags')) {
      return response({
        models: [{ name: 'flux', details: { families: ['diffusion'] } }]
      })
    }
    if (url.endsWith('/api/version')) return response({ version: '0.1.0' })
    if (url.endsWith('/images/generations')) {
      return response({ data: [{ b64_json: 'openai-image' }] })
    }
    if (url.endsWith('/api/generate')) {
      return response({ image: Buffer.alloc(1024, 7).toString('base64') })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    const openaiResult = await runGenerateImageTool('openai', { prompt: 'a test image' })
    assert.equal(openaiResult.ok, true)
    assert.equal(openaiResult.model, 'gpt-image-1')

    const ollamaResult = await runGenerateImageTool('ollama', { prompt: 'a test image' })
    assert.equal(ollamaResult.ok, true)
    assert.equal(ollamaResult.model, 'flux')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('keeps image tool availability scoped to the active provider', async () => {
  setOpenaiModelsCatalog([])
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    if (String(args[0]).endsWith('/api/tags')) {
      return response({
        models: [{ name: 'flux', details: { families: ['diffusion'] } }]
      })
    }
    return response({ version: '0.1.0' })
  }

  try {
    assert.equal(await shouldOfferGenerateImageTool('openai', 'llama3.2'), false)
    assert.equal(await shouldOfferGenerateImageTool('ollama', 'llama3.2'), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects malformed base64 before attempting OpenAI editing', async () => {
  setOpenaiApiKey('test-key')
  setOpenaiModelsCatalog([{ id: 'gpt-image-1', name: 'gpt-image-1' }])
  setOpenaiModelEnabled('gpt-image-1', true)
  setDefaultImageModel('gpt-image-1')
  const originalFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = async (...args) => {
    fetchCalled = String(args[0]).endsWith('/images/edits')
    return response({ data: [{ b64_json: 'unexpected' }] })
  }

  try {
    const result = await runGenerateImageTool('openai', {
      prompt: 'edit this',
      images: ['not-valid-base64']
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /valid base64/)
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects image editing on Ollama without text generation', async () => {
  setOpenaiModelsCatalog([])
  setDefaultImageModel('flux')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    if (String(args[0]).endsWith('/api/tags')) {
      return response({
        models: [{ name: 'flux', details: { families: ['diffusion'] } }]
      })
    }
    return response({ version: '0.1.0' })
  }

  try {
    const result = await runGenerateImageTool('ollama', {
      prompt: 'edit this',
      images: ['base64-image']
    })
    assert.deepEqual(result, {
      ok: false,
      message:
        'Image editing requires an OpenAI image model. Select an OpenAI image model and try again.'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preserves text-only OpenAI result metadata and routing', async () => {
  setOpenaiApiKey('test-key')
  setOpenaiModelsCatalog([{ id: 'dall-e-3', name: 'dall-e-3' }])
  setOpenaiModelEnabled('dall-e-3', true)
  setDefaultImageModel('dall-e-3')
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (...args) => {
    calls.push(args)
    return response({ data: [{ b64_json: 'generated-openai-image' }] })
  }

  try {
    const result = await runGenerateImageTool('openai', {
      prompt: 'a red kite'
    })
    assert.deepEqual(result, {
      ok: true,
      model: 'dall-e-3',
      imageBase64: 'generated-openai-image',
      message: 'Generated image with dall-e-3 via openai'
    })
    const generationCall = calls.find((call) =>
      String(call[0]).endsWith('/images/generations')
    )
    assert.ok(generationCall)
    assert.equal(
      calls.some((call) => String(call[0]).endsWith('/images/edits')),
      false
    )
    const request = JSON.parse(generationCall[1].body)
    assert.deepEqual(request, {
      model: 'dall-e-3',
      prompt: 'a red kite',
      n: 1,
      response_format: 'b64_json'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preserves text-only Ollama result metadata and routing', async () => {
  setOpenaiModelsCatalog([])
  setDefaultImageModel('flux')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    const url = String(args[0])
    if (url.endsWith('/api/tags')) {
      return response({
        models: [{ name: 'flux', details: { families: ['diffusion'] } }]
      })
    }
    if (url.endsWith('/api/version')) return response({ version: '0.1.0' })
    if (url.endsWith('/api/generate')) {
      return response({ image: Buffer.alloc(1024, 7).toString('base64') })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    const result = await runGenerateImageTool('ollama', {
      prompt: 'a blue kite'
    })
    assert.deepEqual(result, {
      ok: true,
      model: 'flux',
      imageBase64: Buffer.alloc(1024, 7).toString('base64'),
      message: 'Generated image with flux via ollama'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
