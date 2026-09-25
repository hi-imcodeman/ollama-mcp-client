import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom'
})

const { prepareGenerateImageToolArguments } = await server.ssrLoadModule(
  new URL('../src/main/agent-image-boundary.ts', import.meta.url).pathname
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
    images: ['model-image', 'current-image', 'second-current-image']
  })
})

test('injects latest user-turn attachments when model images are malformed', () => {
  const result = prepareGenerateImageToolArguments(
    [
      { role: 'user', content: 'earlier turn', images: ['earlier-image'] },
      { role: 'assistant', content: 'earlier response' },
      { role: 'user', content: 'edit this', images: ['first-current-image', 'second-current-image'] }
    ],
    { prompt: 'edit this', images: 'not-an-array' },
  )

  assert.deepEqual(result, {
    prompt: 'edit this',
    images: ['first-current-image', 'second-current-image']
  })
})
