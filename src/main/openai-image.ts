import { getOpenaiApiKey } from './config-store'
import { OPENAI_BASE, formatOpenAiError, parseOpenAiUsageFromJson, type OpenAiUsageDetails } from './openai-client'
import { isOpenAiImageGenModel } from '../shared/openai-models'

export interface OpenAiImageGenerateResult {
  b64: string
  usage?: OpenAiUsageDetails
}

function normalizeBase64(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const match = value.match(/^data:image\/[^;]+;base64,(.+)$/)
  if (value.startsWith('http://') || value.startsWith('https://')) return undefined
  return match?.[1] ?? value
}

function extractBase64FromResponsesBody(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const root = data as Record<string, unknown>
  const output = root.output
  if (!Array.isArray(output)) return undefined

  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const type = String(entry.type ?? '')
    if (type === 'image_generation_call') {
      const result = normalizeBase64(entry.result) ?? normalizeBase64(entry.b64_json)
      if (result) return result
    }
    if (type === 'message' && Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (!part || typeof part !== 'object') continue
        const p = part as Record<string, unknown>
        const image = normalizeBase64(p.image_url) ?? normalizeBase64(p.b64_json)
        if (p.type === 'output_image' && image) return image
        if (image) return image
      }
    }
  }
  return undefined
}

async function openAiImagesGenerate(
  model: string,
  prompt: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<OpenAiImageGenerateResult> {
  const body: Record<string, unknown> = {
    model,
    prompt,
    n: 1
  }
  if (model.toLowerCase().startsWith('dall-e-')) {
    body.response_format = 'b64_json'
  }

  const res = await fetch(`${OPENAI_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(formatOpenAiError(text, res.status))
  }
  const data = (await res.json()) as {
    data?: Array<{ b64_json?: unknown; url?: unknown }>
    usage?: unknown
  }
  const first = data.data?.[0]
  const b64 = normalizeBase64(first?.b64_json) ?? normalizeBase64(first?.url)
  if (!b64) throw new Error('Image API returned no image data')
  return { b64, usage: parseOpenAiUsageFromJson(data.usage) }
}

/**
 * Edit one or more source images via the OpenAI Images Edits API.
 */
export async function editOpenAiImageBase64(
  model: string,
  prompt: string,
  images: string[],
  signal?: AbortSignal
): Promise<OpenAiImageGenerateResult> {
  const apiKey = getOpenaiApiKey()
  if (!apiKey) throw new Error('OpenAI API key not configured')
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('At least one source image is required for image editing')
  }

  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  form.append('n', '1')
  for (const image of images) {
    if (typeof image !== 'string' || !image) {
      throw new Error('Source images must be non-empty base64 payloads')
    }
    const bytes = Buffer.from(image, 'base64')
    if (bytes.length === 0) {
      throw new Error('Source images must be non-empty base64 payloads')
    }
    form.append('image', new Blob([bytes], { type: 'image/png' }), 'image.png')
  }

  const res = await fetch(`${OPENAI_BASE}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(formatOpenAiError(text, res.status))
  }
  const data = (await res.json()) as {
    data?: Array<{ b64_json?: unknown; url?: unknown }>
    usage?: unknown
  }
  const first = data.data?.[0]
  const b64 = normalizeBase64(first?.b64_json) ?? normalizeBase64(first?.url)
  if (!b64) throw new Error('Image API returned no image data')
  return { b64, usage: parseOpenAiUsageFromJson(data.usage) }
}

async function openAiResponsesImageGenerate(
  model: string,
  prompt: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<OpenAiImageGenerateResult> {
  const tryCreate = async (body: Record<string, unknown>): Promise<OpenAiImageGenerateResult> => {
    const res = await fetch(`${OPENAI_BASE}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(formatOpenAiError(text, res.status))
    }
    const data = await res.json()
    const b64 = extractBase64FromResponsesBody(data)
    if (!b64) throw new Error('Responses API returned no image data')
    const root = data as Record<string, unknown>
    return { b64, usage: parseOpenAiUsageFromJson(root.usage) }
  }

  const toolSpec: Record<string, unknown> = { type: 'image_generation' }
  if (isOpenAiImageGenModel(model)) {
    toolSpec.model = model
  }

  const attempts: Record<string, unknown>[] = [
    { model, input: prompt },
    {
      model: 'gpt-4.1-mini',
      input: prompt,
      tools: [toolSpec]
    }
  ]

  let lastError: Error | undefined
  for (const body of attempts) {
    try {
      return await tryCreate(body)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error('OpenAI image generation failed')
}

/**
 * Generate an image via OpenAI Images API, falling back to Responses API when required.
 */
export async function generateOpenAiImageBase64(
  model: string,
  prompt: string,
  signal?: AbortSignal
): Promise<OpenAiImageGenerateResult> {
  const apiKey = getOpenaiApiKey()
  if (!apiKey) throw new Error('OpenAI API key not configured')

  if (isOpenAiImageGenModel(model)) {
    try {
      return await openAiResponsesImageGenerate(model, prompt, apiKey, signal)
    } catch (responsesErr) {
      try {
        return await openAiImagesGenerate(model, prompt, apiKey, signal)
      } catch {
        throw responsesErr
      }
    }
  }

  try {
    return await openAiImagesGenerate(model, prompt, apiKey, signal)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (
      msg.includes('v1/responses') ||
      msg.toLowerCase().includes('only supported in')
    ) {
      return openAiResponsesImageGenerate(model, prompt, apiKey, signal)
    }
    throw err
  }
}
