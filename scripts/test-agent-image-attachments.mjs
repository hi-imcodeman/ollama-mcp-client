import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  plugins: [
    {
      name: 'mock-electron-for-agent-test',
      enforce: 'pre',
      resolveId(id) {
        return id === 'electron'
          ? { id: '\0mock-electron', external: false }
          : undefined
      },
      load(id) {
        if (id !== '\0mock-electron') return undefined
        return 'export const BrowserWindow = { getAllWindows: () => [] }'
      }
    }
  ]
})

const { mergeGenerateImageToolArguments } = await server.ssrLoadModule(
  new URL('../src/main/image-gen-tool.ts', import.meta.url).pathname
)

after(() => server.close())

test('merges only current-turn images with model images and deduplicates exact payloads', () => {
  const result = mergeGenerateImageToolArguments(
    { prompt: 'combine these', images: ['model-image', 'current-image'] },
    ['current-image', 'second-current-image']
  )

  assert.deepEqual(result, {
    prompt: 'combine these',
    images: ['model-image', 'current-image', 'second-current-image']
  })
})
