/** GPT Image and similar models that generate images from text (not vision chat). */
export function isOpenAiImageGenModel(model: string): boolean {
  const lower = model.toLowerCase()
  if (lower.startsWith('gpt-image')) return true
  if (lower.startsWith('dall-e')) return true
  if (/^gpt-[\d].*image/.test(lower)) return true
  return false
}

/** OpenAI chat models that support image input. */
export function isOpenAiVisionModel(model: string): boolean {
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
