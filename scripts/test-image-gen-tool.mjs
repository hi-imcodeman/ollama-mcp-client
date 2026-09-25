import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom'
})

const { generateImageToolDefinition, runGenerateImageTool } =
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
      images: ['base64-image', 'other-image', 'base64-image']
    })
    assert.deepEqual(result, {
      ok: true,
      model: 'gpt-image-1',
      imageBase64: 'edited-image',
      message: 'Generated image with gpt-image-1 via openai'
    })
    const request = calls.at(-1)[1]
    assert.deepEqual(request.body.getAll('image').length, 2)
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
