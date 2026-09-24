import type { OpenAiModelEntry } from '../shared/types'
import type { OllamaChatMessage, OllamaTool } from './ollama'
import { getOpenaiApiKey } from './config-store'
import { isOpenAiImageGenModel } from './openai-image'

export const OPENAI_BASE = 'https://api.openai.com/v1'

export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase()
  if (lower.startsWith('text-embedding-')) return false
  if (lower.startsWith('whisper-')) return false
  if (lower.startsWith('tts-')) return false
  if (lower.startsWith('dall-e-')) return false
  if (lower.includes('realtime')) return false
  return true
}

/**
 * Models that accept `reasoning_effort` on Chat Completions (o-series, GPT-5+, etc.).
 * Standard GPT-4.x / GPT-4o models reject the parameter entirely.
 */
export function openAiModelUsesReasoningEffort(model: string): boolean {
  const lower = model.toLowerCase()
  if (/^o\d/.test(lower)) return true
  const major = lower.match(/^gpt-(\d+)/)?.[1]
  if (major && Number.parseInt(major, 10) >= 5) return true
  if (lower.includes('reasoning')) return true
  return false
}

export async function fetchOpenAiModels(apiKey: string): Promise<OpenAiModelEntry[]> {
  const res = await fetch(`${OPENAI_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  const data = (await res.json()) as {
    data?: Array<{ id: string; owned_by?: string; created?: number }>
  }
  return (data.data ?? [])
    .filter((m) => isChatModelId(m.id))
    .map((m) => ({ id: m.id, ownedBy: m.owned_by, created: m.created }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function validateOpenAiKey(
  apiKey: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await fetchOpenAiModels(apiKey)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function fetchOpenAiChatModels(): Promise<OpenAiModelEntry[]> {
  const key = getOpenaiApiKey()
  if (!key) throw new Error('OpenAI API key not configured')
  return fetchOpenAiModels(key)
}

export type OpenAiChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | OpenAiContentPart[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface OpenAiToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface OpenAiUsageDetails {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens: number
  reasoningTokens: number
}

export function parseOpenAiUsageFromJson(usage: unknown): OpenAiUsageDetails | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const prompt =
    typeof u.prompt_tokens === 'number'
      ? u.prompt_tokens
      : typeof u.input_tokens === 'number'
        ? u.input_tokens
        : 0
  const completion =
    typeof u.completion_tokens === 'number'
      ? u.completion_tokens
      : typeof u.output_tokens === 'number'
        ? u.output_tokens
        : 0
  const total =
    typeof u.total_tokens === 'number' ? u.total_tokens : prompt + completion
  const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined
  const completionDetails = u.completion_tokens_details as Record<string, unknown> | undefined
  const cached =
    typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : 0
  const reasoning =
    typeof completionDetails?.reasoning_tokens === 'number'
      ? completionDetails.reasoning_tokens
      : 0
  if (prompt === 0 && completion === 0 && total === 0) return undefined
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    cachedPromptTokens: cached,
    reasoningTokens: reasoning
  }
}

export interface OpenAiStreamResult {
  content: string
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
  promptEvalCount?: number
  evalCount?: number
  usage?: OpenAiUsageDetails
}

export function formatOpenAiError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch {
    // keep raw
  }
  return text || `HTTP ${status}`
}

function normalizeToolArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    return JSON.parse(args) as Record<string, unknown>
  } catch {
    return { value: args }
  }
}

export function ollamaMessagesToOpenAi(messages: OllamaChatMessage[]): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.tool_call_id ?? m.tool_name ?? 'tool',
        content: m.content
      })
      continue
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.tool_calls.map((tc, i) => ({
          id: tc.id ?? `call_${i}`,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments ?? {})
          }
        }))
      } as OpenAiChatMessage)
      continue
    }

    const parts: OpenAiContentPart[] = []
    if (m.content) parts.push({ type: 'text', text: m.content })
    if (m.images?.length) {
      for (const img of m.images) {
        const url = img.startsWith('data:') ? img : `data:image/png;base64,${img}`
        parts.push({ type: 'image_url', image_url: { url } })
      }
    }
    const role = m.role as 'system' | 'user' | 'assistant'
    if (parts.length === 0) {
      out.push({ role, content: m.content ?? '' })
    } else if (parts.length === 1 && parts[0]?.type === 'text') {
      out.push({ role, content: m.content })
    } else {
      out.push({ role, content: parts })
    }
  }
  return out
}

export function ollamaToolsToOpenAi(tools: OllamaTool[]): OpenAiToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }
  }))
}

export async function openAiChatOnce(options: {
  model: string
  messages: OllamaChatMessage[]
  apiKey?: string
  signal?: AbortSignal
}): Promise<string> {
  const apiKey = options.apiKey ?? getOpenaiApiKey()
  if (!apiKey) throw new Error('OpenAI API key not configured')

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: options.model,
      messages: ollamaMessagesToOpenAi(options.messages),
      stream: false
    }),
    signal: options.signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(formatOpenAiError(text, res.status))
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content ?? ''
}

export async function openAiChatStream(options: {
  model: string
  messages: OllamaChatMessage[]
  tools?: OllamaTool[]
  apiKey?: string
  signal?: AbortSignal
}): Promise<OpenAiStreamResult> {
  const apiKey = options.apiKey ?? getOpenaiApiKey()
  if (!apiKey) throw new Error('OpenAI API key not configured')

  if (isOpenAiImageGenModel(options.model)) {
    throw new Error(
      `"${options.model}" is an image generation model. Enter an image prompt; the app uses the Images / Responses API, not chat completions.`
    )
  }

  const body: Record<string, unknown> = {
    model: options.model,
    messages: ollamaMessagesToOpenAi(options.messages),
    stream: true,
    stream_options: { include_usage: true }
  }
  if (options.tools?.length) {
    body.tools = ollamaToolsToOpenAi(options.tools)
    if (openAiModelUsesReasoningEffort(options.model)) {
      // Reasoning models default non-none effort; tools on chat/completions require none.
      body.reasoning_effort = 'none'
    }
  }

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: options.signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(formatOpenAiError(text, res.status))
  }
  if (!res.body) throw new Error('Empty response body')

  let content = ''
  const toolCallsByIndex = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()
  let promptEvalCount: number | undefined
  let evalCount: number | undefined
  let usage: OpenAiUsageDetails | undefined

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
          }>
          usage?: unknown
        }
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) content += delta.content
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            let acc = toolCallsByIndex.get(idx)
            if (!acc) {
              acc = { id: tc.id ?? `call_${idx}`, name: '', arguments: '' }
              toolCallsByIndex.set(idx, acc)
            }
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
          }
        }
        if (chunk.usage) {
          const parsed = parseOpenAiUsageFromJson(chunk.usage)
          if (parsed) {
            usage = parsed
            promptEvalCount = parsed.promptTokens
            evalCount = parsed.completionTokens
          }
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      name: tc.name,
      arguments: normalizeToolArgs(tc.arguments)
    }))

  return { content, toolCalls, promptEvalCount, evalCount, usage }
}
