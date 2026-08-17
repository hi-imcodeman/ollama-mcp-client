import type { ChatMessage } from '../shared/types'
import { estimateChatMessagesTokens } from '../shared/contextUsage'
import { chatOnce } from './ollama'

/** Trigger compaction when estimated usage reaches this fraction of the limit. */
export const COMPACT_THRESHOLD = 0.75
/** Leave roughly this fraction free for the reply + tools after compact. */
const TARGET_HEADROOM = 0.25
/** On a small window, keep only the latest user turn verbatim. */
const DEFAULT_KEEP_TURNS = 1
const SUMMARY_PREFIX = 'Conversation summary (earlier messages compacted):\n\n'

export function isSummaryMessage(m: ChatMessage): boolean {
  return (
    (m.role === 'system' || m.role === 'user') &&
    m.content.startsWith('Conversation summary (earlier messages compacted):')
  )
}

export function estimatedContextUsed(
  messages: ChatMessage[],
  extraTokens = 0,
  measuredUsed?: number | null
): number {
  return Math.max(
    estimateChatMessagesTokens(messages) + extraTokens,
    measuredUsed ?? 0
  )
}

export function shouldCompact(
  messages: ChatMessage[],
  limit: number | undefined,
  measuredUsed?: number | null,
  extraTokens = 0
): boolean {
  if (!limit || limit <= 0) return false
  const used = estimatedContextUsed(messages, extraTokens, measuredUsed)
  if (used < limit * COMPACT_THRESHOLD) return false
  // Need something besides the last user prompt to fold into a summary.
  return splitKeepingLastUser(messages).older.length > 0
}

/**
 * Split history into older (to summarize) and recent (keep verbatim).
 * A "turn" starts at a user message and includes following assistant/tool msgs.
 */
export function splitForCompact(
  messages: ChatMessage[],
  keepTurns = DEFAULT_KEEP_TURNS
): { older: ChatMessage[]; recent: ChatMessage[] } {
  if (messages.length === 0) return { older: [], recent: [] }

  const turnStarts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') turnStarts.push(i)
  }

  // Always leave at least one earlier turn to summarize when possible.
  if (turnStarts.length >= 2) {
    const keep = Math.max(1, Math.min(keepTurns, turnStarts.length - 1))
    const startIdx = turnStarts[turnStarts.length - keep]
    return {
      older: messages.slice(0, startIdx),
      recent: messages.slice(startIdx)
    }
  }

  return { older: [], recent: messages }
}

/** Keep only the last user prompt; fold summary, tools, and the latest reply. */
export function splitKeepingLastUser(messages: ChatMessage[]): {
  older: ChatMessage[]
  recent: ChatMessage[]
} {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !isSummaryMessage(messages[i])) {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return { older: [], recent: messages }
  return {
    older: messages.filter((_, i) => i !== lastUserIdx),
    recent: [messages[lastUserIdx]]
  }
}

function formatMessagesForSummary(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (isSummaryMessage(m)) {
      parts.push(`[Prior summary]\n${m.content.replace(SUMMARY_PREFIX, '')}`)
      continue
    }
    const role = m.role.toUpperCase()
    let body = m.content?.trim() ?? ''
    if (m.tool_calls?.length) {
      body +=
        (body ? '\n' : '') +
        m.tool_calls
          .map(
            (tc) =>
              `[tool call] ${tc.name}(${JSON.stringify(tc.arguments)})`
          )
          .join('\n')
    }
    if (m.tool_name) {
      body = `[tool result: ${m.tool_name}]\n${body}`
    }
    if (m.images?.length) {
      body += (body ? '\n' : '') + `[${m.images.length} image(s) attached]`
    }
    if (!body) continue
    // Cap very long tool dumps in the summarizer prompt
    if (body.length > 4000) {
      body = `${body.slice(0, 4000)}\n…[truncated]`
    }
    parts.push(`${role}:\n${body}`)
  }
  return parts.join('\n\n')
}

export async function summarizeHistory(options: {
  model: string
  older: ChatMessage[]
  signal?: AbortSignal
  numCtx?: number
}): Promise<string> {
  const transcript = formatMessagesForSummary(options.older)
  const content = await chatOnce({
    model: options.model,
    signal: options.signal,
    numCtx: options.numCtx,
    numPredict: 512,
    messages: [
      {
        role: 'system',
        content:
          'You compress chat history for a coding assistant. Write a concise summary that preserves: user goals, key decisions, facts, file/tool outcomes, and open tasks. Omit fluff and repeated back-and-forth. Use short bullets or tight paragraphs. Do not continue the conversation — only output the summary.'
      },
      {
        role: 'user',
        content: `Summarize this earlier conversation:\n\n${transcript}`
      }
    ]
  })
  if (!content) {
    throw new Error('Summarizer returned empty content')
  }
  return content
}

function makeSummaryMessage(summary: string): ChatMessage {
  return {
    role: 'system',
    content: `${SUMMARY_PREFIX}${summary}`
  }
}

/** Drop oldest non-summary messages until under target token budget. */
export function truncateOldest(
  messages: ChatMessage[],
  limit: number,
  headroom = TARGET_HEADROOM
): ChatMessage[] {
  const target = Math.floor(limit * (1 - headroom))
  if (estimateChatMessagesTokens(messages) <= target) return messages

  const out = [...messages]
  while (out.length > 2 && estimateChatMessagesTokens(out) > target) {
    // Prefer dropping just after an existing summary, else from the front
    const dropIdx = isSummaryMessage(out[0]) && out.length > 1 ? 1 : 0
    out.splice(dropIdx, 1)
  }
  return out
}

export interface CompactResult {
  messages: ChatMessage[]
  summarized: boolean
  summary?: string
}

/**
 * Compact model history when near the context limit.
 * On summarizer failure, falls back to truncating oldest messages.
 */
export async function compactIfNeeded(options: {
  model: string
  messages: ChatMessage[]
  limit: number | undefined
  measuredUsed?: number | null
  extraTokens?: number
  signal?: AbortSignal
}): Promise<CompactResult> {
  const { model, limit, measuredUsed, signal } = options
  const extraTokens = options.extraTokens ?? 0
  const messages = options.messages

  if (!shouldCompact(messages, limit, measuredUsed, extraTokens) || !limit) {
    return { messages, summarized: false }
  }

  const recentBudget = Math.floor(limit * (1 - TARGET_HEADROOM) * 0.7)
  let { older, recent } = splitForCompact(messages, DEFAULT_KEEP_TURNS)

  const lastTurnTooBig =
    estimateChatMessagesTokens(recent) + extraTokens > recentBudget
  const olderIsOnlySummary =
    older.length > 0 && older.every(isSummaryMessage)

  if (older.length === 0 || lastTurnTooBig || olderIsOnlySummary) {
    ;({ older, recent } = splitKeepingLastUser(messages))
  }

  if (older.length === 0) {
    const trimmed = truncateOldest(messages, limit)
    return {
      messages: trimmed,
      summarized: trimmed.length < messages.length
    }
  }

  try {
    const summary = await summarizeHistory({
      model,
      older,
      signal,
      numCtx: limit
    })
    if (signal?.aborted) {
      return { messages, summarized: false }
    }
    let compacted: ChatMessage[] = [makeSummaryMessage(summary), ...recent]

    if (estimatedContextUsed(compacted, extraTokens) > limit * COMPACT_THRESHOLD) {
      compacted = truncateOldest(compacted, limit)
    }

    return { messages: compacted, summarized: true, summary }
  } catch (err) {
    if (signal?.aborted) {
      return { messages, summarized: false }
    }
    console.warn(
      '[compact] summarizer failed, truncating oldest:',
      err instanceof Error ? err.message : err
    )
    const trimmed = truncateOldest(messages, limit)
    return {
      messages: trimmed,
      summarized: trimmed.length < messages.length
    }
  }
}
