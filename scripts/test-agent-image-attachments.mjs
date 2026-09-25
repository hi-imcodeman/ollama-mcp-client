import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom'
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
