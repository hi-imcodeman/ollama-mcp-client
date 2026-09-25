import assert from 'node:assert/strict'

// Keep this pure check aligned with src/shared/openai-models.ts. It intentionally
// avoids importing TypeScript so it runs with plain `node`.
function isOpenAiImageGenModel(model) {
  const lower = model.toLowerCase()
  if (lower.startsWith('gpt-image')) return true
  if (lower.startsWith('chatgpt-image')) return true
  if (lower.startsWith('dall-e')) return true
  if (/^gpt-[\d].*image/.test(lower)) return true
  return false
}

function isOpenAiVisionModel(model) {
  const lower = model.toLowerCase()
  if (isOpenAiImageGenModel(lower)) return false
  if (lower.includes('vision')) return true
  if (/^gpt-(?:4o|4\.1|4\.5)(?:-|$)/.test(lower)) return true

  const gptFamily = lower.match(/^gpt-(\d+)(?:\.\d+)?(?:-|$)/)
  if (gptFamily && Number(gptFamily[1]) >= 5) return true

  if (/^o1(?:-|$)/.test(lower)) return true
  if (/^o3(?:-|$)/.test(lower)) return true
  if (/^o4-mini(?:-|$)/.test(lower)) return true
  return false
}

for (const model of ['gpt-image-1', 'chatgpt-image-1', 'chatgpt-image-latest', 'dall-e-3']) {
  assert.equal(isOpenAiImageGenModel(model), true, `${model} should be image-only`)
  assert.equal(isOpenAiVisionModel(model), false, `${model} should not be vision chat`)
}

for (const model of ['gpt-4o', 'gpt-4.1-mini', 'o3', 'o4-mini', 'gpt-6']) {
  assert.equal(isOpenAiVisionModel(model), true, `${model} should support vision`)
  assert.equal(isOpenAiImageGenModel(model), false, `${model} should not be image-only`)
}

for (const model of ['gpt-3.5-turbo', 'totally-unknown-model']) {
  assert.equal(isOpenAiVisionModel(model), false, `${model} should not be known vision`)
  assert.equal(isOpenAiImageGenModel(model), false, `${model} should not be image-only`)
}

console.log('OpenAI vision/image classifier checks passed')
