import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom'
})

const { ollamaMessagesToOpenAi } = await server.ssrLoadModule(
  new URL('../src/main/openai-client.ts', import.meta.url).pathname
)
const { toOllamaMessages } = await server.ssrLoadModule(
  new URL('../src/main/ollama.ts', import.meta.url).pathname
)

after(() => server.close())

test('preserves image MIME metadata through Ollama conversion for OpenAI chat', () => {
  const messages = toOllamaMessages([
    {
      role: 'user',
      content: 'compare these',
      images: ['jpeg-bytes', 'png-bytes'],
      imageMimes: ['image/jpeg', 'image/png']
    }
  ])

  const converted = ollamaMessagesToOpenAi(messages)
  assert.deepEqual(
    converted[0].content,
    [
      { type: 'text', text: 'compare these' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,jpeg-bytes' }
      },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,png-bytes' }
      }
    ]
  )
})

test('keeps legacy raw Ollama images as PNG', () => {
  const converted = ollamaMessagesToOpenAi([
    { role: 'user', content: '', images: ['legacy-bytes'] }
  ])

  assert.deepEqual(converted[0].content, [
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,legacy-bytes' }
    }
  ])
})
