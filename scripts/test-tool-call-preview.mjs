import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom'
})

const { summarizeToolArguments } = await server.ssrLoadModule(
  new URL('../src/renderer/src/components/ToolCallCard.tsx', import.meta.url).pathname
)

test('summarizes tool arguments without exposing image payloads', () => {
  assert.deepEqual(
    summarizeToolArguments({
      prompt: 'remove the background',
      images: ['a'.repeat(1000), 'b'.repeat(1000)]
    }),
    ['prompt: "remove the background"', 'images: 2 attached image(s)']
  )
})

await server.close()
