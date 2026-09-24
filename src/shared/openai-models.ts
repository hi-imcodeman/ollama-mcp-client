/** GPT Image and similar models that generate images from text (not vision chat). */
export function isOpenAiImageGenModel(model: string): boolean {
  const lower = model.toLowerCase()
  if (lower.startsWith('gpt-image')) return true
  if (lower.startsWith('dall-e')) return true
  if (/^gpt-[\d].*image/.test(lower)) return true
  return false
}
