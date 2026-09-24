import { getOpenaiApiKey } from './config-store'
import { OPENAI_BASE, formatOpenAiError, parseOpenAiUsageFromJson, type OpenAiUsageDetails } from './openai-client'
import { isOpenAiImageGenModel } from '../shared/openai-models'

export interface OpenAiImageGenerateResult {
  b64: string
  usage?: OpenAiUsageDetails
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
      if (typeof entry.result === 'string' && entry.result.length > 0) {
        return entry.result
      }
      if (typeof entry.b64_json === 'string' && entry.b64_json.length > 0) {
        return entry.b64_json
      }
    }
    if (type === 'message' && Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (!part || typeof part !== 'object') continue
        const p = part as Record<string, unknown>
        if (p.type === 'output_image' && typeof p.image_url === 'string') {
          const url = p.image_url
          const m = url.match(/^data:image\/[^;]+;base64,(.+)$/)
          if (m?.[1]) return m[1]
        }
        if (typeof p.b64_json === 'string' && p.b64_json.length > 0) {
          return p.b64_json
        }
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
  const res = await fetch(`${OPENAI_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      response_format: 'b64_json'
    }),
    signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(formatOpenAiError(text, res.status))
  }
  const data = (await res.json()) as {
    data?: Array<{ b64_json?: string }>
    usage?: unknown
  }
  const b64 = data.data?.[0]?.b64_json
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
