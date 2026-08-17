import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import type { ChatEvent, ChatMessage, ChatSendPayload } from '../shared/types'
import { compactIfNeeded, shouldCompact } from './context-compact'
import { estimateChatMessagesTokens, estimateTokensFromChars } from '../shared/contextUsage'
import { mcpManager } from './mcp-manager'
import { generateImageBase64 } from './ollama-image'
import {
  chatStream,
  detectVisionSupport,
  getModelInfo,
  modelIsImageGen,
  resolveContextLength,
  toOllamaMessages,
  type OllamaChatMessage,
  type OllamaTool
} from './ollama'

const MAX_TOOL_ITERATIONS = 8
/** Cap tool payloads sent back to the model; UI still gets the full result. */
const MAX_TOOL_RESULT_CHARS = 24_000
const MIN_NUM_PREDICT = 256
const PREDICT_RESERVE = 64

let activeAbort: AbortController | null = null
let activeTurnId: string | null = null

function emit(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('chat:event', event)
  }
}

function ms(startedAt: number, endedAt = Date.now()): string {
  const n = Math.max(0, endedAt - startedAt)
  if (n < 1000) return `${n}ms`
  const sec = n / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

function approxChars(messages: OllamaChatMessage[]): number {
  return messages.reduce((sum, m) => {
    let n = m.content?.length ?? 0
    if (m.tool_calls?.length) {
      n += JSON.stringify(m.tool_calls).length
    }
    if (m.images?.length) {
      n += m.images.reduce((a, img) => a + img.length, 0)
    }
    return sum + n
  }, 0)
}

function shortTurnId(turnId?: string): string {
  return turnId ? turnId.slice(0, 8) : '—'
}

function estimateToolOverhead(tools: OllamaTool[]): number {
  if (tools.length === 0) return 0
  return estimateTokensFromChars(JSON.stringify(tools).length)
}

function estimatePromptTokens(
  messages: OllamaChatMessage[],
  toolOverhead: number
): number {
  return estimateTokensFromChars(approxChars(messages)) + toolOverhead
}

function replyNumPredict(
  limit: number | undefined,
  promptTokens: number
): number | undefined {
  if (!limit || limit <= 0) return undefined
  return Math.max(MIN_NUM_PREDICT, limit - promptTokens - PREDICT_RESERVE)
}

function occupancyUsed(messages: ChatMessage[], extraTokens: number): number {
  return estimateChatMessagesTokens(messages) + extraTokens
}

type EmitTurn = (event: Exclude<ChatEvent, { type: 'user' }>) => void

async function applyCompact(options: {
  model: string
  messages: ChatMessage[]
  limit: number | undefined
  measuredUsed?: number | null
  extraTokens: number
  signal: AbortSignal
  turnId: string
  emitTurn: EmitTurn
}): Promise<ChatMessage[]> {
  const {
    model,
    messages,
    limit,
    measuredUsed,
    extraTokens,
    signal,
    turnId,
    emitTurn
  } = options

  if (!shouldCompact(messages, limit, measuredUsed, extraTokens)) {
    return messages
  }

  emitTurn({
    type: 'status',
    phase: 'compacting',
    detail: 'Compressing conversation…'
  })

  const compact = await compactIfNeeded({
    model,
    messages,
    limit,
    measuredUsed,
    extraTokens,
    signal
  })

  if (signal.aborted || activeTurnId !== turnId) {
    return messages
  }

  if (!compact.summarized) return compact.messages

  console.log(
    `[agent] compacted id=${turnId.slice(0, 8)} before=${messages.length} after=${compact.messages.length}`
  )
  emitTurn({ type: 'compacted', messages: compact.messages })
  if (compact.summary) {
    emitTurn({
      type: 'notice',
      content: 'Summarized earlier chat',
      summary: compact.summary
    })
  } else {
    emitTurn({
      type: 'notice',
      content: 'Trimmed earlier chat to fit context'
    })
  }
  return compact.messages
}

function truncateForModel(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result
  const kept = result.slice(0, MAX_TOOL_RESULT_CHARS)
  return (
    `${kept}\n\n…[truncated ${result.length - MAX_TOOL_RESULT_CHARS} of ${result.length} chars for the model; full result is shown in the UI. Prefer a narrower query or summarize from this sample.]`
  )
}

function toolsFromMcp(): OllamaTool[] {
  return mcpManager.listAllTools().map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.prefixedName,
      description: tool.description ?? `Tool ${tool.name} from ${tool.serverName}`,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} }
    }
  }))
}

export function abortChat(): void {
  if (activeAbort) {
    activeAbort.abort()
    activeAbort = null
  }
  activeTurnId = null
}

export async function runAgentTurn(payload: ChatSendPayload): Promise<void> {
  abortChat()
  const abort = new AbortController()
  activeAbort = abort
  const turnId = payload.turnId
  activeTurnId = turnId

  const emitTurn = (event: Exclude<ChatEvent, { type: 'user' }>): void => {
    emit({ ...event, turnId })
  }

  let emittedDone = false
  const finish = (): void => {
    if (emittedDone) return
    emittedDone = true
    emitTurn({ type: 'done' })
  }

  const tools = toolsFromMcp()
  const turnStartedAt = Date.now()
  const tid = shortTurnId(turnId)

  console.log(
    `[agent] turn start id=${tid} model=${payload.model} messages=${payload.messages.length} tools=${tools.length}`
  )

  // Image-generation models use /api/generate instead of the chat/tools loop.
  const modelInfo = await getModelInfo(payload.model).catch(() => null)
  const contextLimit = await resolveContextLength(payload.model, modelInfo)

  const emitContext = (promptEvalCount?: number, evalCount?: number): void => {
    if (promptEvalCount == null && evalCount == null) return
    emitTurn({
      type: 'context',
      used: (promptEvalCount ?? 0) + (evalCount ?? 0),
      limit: contextLimit ?? 0
    })
  }
  if (modelIsImageGen(payload.model, modelInfo)) {
    const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user')
    const prompt = (lastUser?.content ?? '').trim()
    if (!prompt) {
      emitTurn({ type: 'error', message: 'Enter a prompt describing the image to generate.' })
      finish()
      return
    }

    emitTurn({
      type: 'status',
      phase: 'generating',
      detail: 'Generating image…'
    })

    try {
      const imageBase64 = await generateImageBase64(
        payload.model,
        prompt,
        abort.signal
      )
      if (abort.signal.aborted || activeTurnId !== turnId) {
        emitTurn({ type: 'error', message: 'Aborted' })
        return
      }
      console.log(
        `[agent] image done id=${tid} bytes=${imageBase64.length} +${ms(turnStartedAt)}`
      )
      emitTurn({
        type: 'assistant_images',
        images: [imageBase64],
        mime: 'image/png'
      })
      finish()
      return
    } catch (err) {
      if (abort.signal.aborted || activeTurnId !== turnId) {
        emitTurn({ type: 'error', message: 'Aborted' })
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[agent] image error id=${tid}`, message)
      emitTurn({ type: 'error', message })
      finish()
      return
    }
  }

  // Compact older history when near the context window (model history only).
  const toolOverhead = estimateToolOverhead(tools)
  let workingMessages = payload.messages
  try {
    workingMessages = await applyCompact({
      model: payload.model,
      messages: workingMessages,
      limit: contextLimit,
      measuredUsed: payload.contextUsed,
      extraTokens: toolOverhead,
      signal: abort.signal,
      turnId,
      emitTurn
    })
    if (abort.signal.aborted || activeTurnId !== turnId) {
      emitTurn({ type: 'error', message: 'Aborted' })
      return
    }
    if (contextLimit) {
      emitTurn({
        type: 'context',
        used: occupancyUsed(workingMessages, toolOverhead),
        limit: contextLimit
      })
    }
  } catch (err) {
    if (abort.signal.aborted || activeTurnId !== turnId) {
      emitTurn({ type: 'error', message: 'Aborted' })
      return
    }
    console.warn(
      '[agent] compact skipped:',
      err instanceof Error ? err.message : err
    )
  }

  const messages: OllamaChatMessage[] = toOllamaMessages(workingMessages)
  console.log(
    `[agent] prompt ready id=${tid} messages=${messages.length} chars≈${approxChars(messages)}`
  )

  const imageStats = messages
    .filter((m) => m.images?.length)
    .map((m) => ({
      role: m.role,
      count: m.images!.length,
      bytes: m.images!.map((img) => img.length)
    }))
  if (imageStats.length) {
    console.log('[agent] image payloads', imageStats)
    const info = modelInfo ?? (await getModelInfo(payload.model).catch(() => null))
    const support = detectVisionSupport(payload.model, info)
    if (support === 'no') {
      emitTurn({
        type: 'error',
        message: `Model "${payload.model}" does not support vision/images. Switch to a vision model (e.g. llava, llama3.2-vision, gemma3) and try again.`
      })
      finish()
      return
    }
    const empty = imageStats.some((s) => s.bytes.some((b) => b < 32))
    if (empty) {
      emitTurn({
        type: 'error',
        message: 'Attached image data was empty after transfer. Try a smaller JPEG/PNG.'
      })
      finish()
      return
    }
  }

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (abort.signal.aborted || activeTurnId !== turnId) {
        console.log(`[agent] aborted before iter=${iteration} id=${tid}`)
        emitTurn({ type: 'error', message: 'Aborted' })
        return
      }

      const phase = iteration === 0 ? 'thinking' : 'synthesizing'
      const iterStartedAt = Date.now()
      console.log(
        `[agent] iter=${iteration} phase=${phase} id=${tid} promptMessages=${messages.length} chars≈${approxChars(messages)} (+${ms(turnStartedAt)} since turn)`
      )

      emitTurn({
        type: 'status',
        phase,
        detail:
          iteration === 0
            ? 'Waiting for the model…'
            : `Continuing after tools (step ${iteration + 1})…`
      })

      let streamedContent = ''
      let sawContent = false
      let sawThinking = false
      let firstThinkingAt: number | null = null
      let firstContentAt: number | null = null
      let firstToolCallAt: number | null = null

      const { content, toolCalls, promptEvalCount, evalCount } = await chatStream({
        model: payload.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        signal: abort.signal,
        numCtx: contextLimit,
        numPredict: replyNumPredict(
          contextLimit,
          estimatePromptTokens(messages, toolOverhead)
        ),
        onChunk: (chunk) => {
          if (activeTurnId !== turnId) return

          const thinking = chunk.message?.thinking
          if (thinking) {
            if (!sawThinking) {
              sawThinking = true
              firstThinkingAt = Date.now()
              console.log(
                `[agent] iter=${iteration} first-thinking +${ms(iterStartedAt)} id=${tid}`
              )
              emitTurn({
                type: 'status',
                phase: 'thinking',
                detail: 'Model is reasoning…'
              })
            }
            emitTurn({ type: 'thinking', content: thinking })
          }

          const text = chunk.message?.content
          if (text) {
            if (!sawContent) {
              sawContent = true
              firstContentAt = Date.now()
              console.log(
                `[agent] iter=${iteration} first-content +${ms(iterStartedAt)} id=${tid}`
              )
              emitTurn({
                type: 'status',
                phase: 'generating',
                detail: 'Writing a reply…'
              })
            }
            streamedContent += text
            emitTurn({ type: 'chunk', content: text })
          }

          if (chunk.message?.tool_calls?.length && !sawContent) {
            if (firstToolCallAt == null) {
              firstToolCallAt = Date.now()
              console.log(
                `[agent] iter=${iteration} first-tool-call +${ms(iterStartedAt)} id=${tid}`
              )
            }
            emitTurn({
              type: 'status',
              phase: 'tool',
              detail: 'Choosing tools…'
            })
          }
        }
      })

      if (abort.signal.aborted || activeTurnId !== turnId) {
        console.log(`[agent] aborted after stream iter=${iteration} id=${tid}`)
        emitTurn({ type: 'error', message: 'Aborted' })
        return
      }

      const finalContent = content || streamedContent
      if (toolCalls.length > 0) {
        emitContext(promptEvalCount, evalCount)
      }
      console.log(
        `[agent] iter=${iteration} stream-done +${ms(iterStartedAt)} id=${tid} contentChars=${finalContent.length} tools=${toolCalls.length}` +
          (firstThinkingAt != null
            ? ` ttf-thinking=${ms(iterStartedAt, firstThinkingAt)}`
            : '') +
          (firstContentAt != null
            ? ` ttf-content=${ms(iterStartedAt, firstContentAt)}`
            : '') +
          (firstToolCallAt != null
            ? ` ttf-tool=${ms(iterStartedAt, firstToolCallAt)}`
            : '')
      )

      if (toolCalls.length === 0) {
        // Always complete the turn so the UI leaves thinking/synthesizing,
        // even when the model returns an empty final message after tools.
        console.log(
          `[agent] turn done id=${tid} total=${ms(turnStartedAt)} iterations=${iteration + 1}`
        )
        const withReply: ChatMessage[] = finalContent
          ? [...workingMessages, { role: 'assistant', content: finalContent }]
          : workingMessages
        const used = (promptEvalCount ?? 0) + (evalCount ?? 0)
        emitTurn({ type: 'assistant_done', content: finalContent })
        try {
          const compacted = await applyCompact({
            model: payload.model,
            messages: withReply,
            limit: contextLimit,
            measuredUsed: used,
            extraTokens: toolOverhead,
            signal: abort.signal,
            turnId,
            emitTurn
          })
          if (abort.signal.aborted || activeTurnId !== turnId) {
            emitTurn({ type: 'error', message: 'Aborted' })
            return
          }
          if (contextLimit) {
            emitTurn({
              type: 'context',
              used: occupancyUsed(compacted, toolOverhead),
              limit: contextLimit
            })
          }
        } catch (err) {
          console.warn(
            '[agent] post-turn compact skipped:',
            err instanceof Error ? err.message : err
          )
          if (contextLimit) {
            emitTurn({
              type: 'context',
              used: occupancyUsed(withReply, toolOverhead),
              limit: contextLimit
            })
          }
        }
        return
      }

      const assistantMsg: OllamaChatMessage = {
        role: 'assistant',
        content: finalContent,
        tool_calls: toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments }
        }))
      }
      messages.push(assistantMsg)

      for (const tc of toolCalls) {
        const id = randomUUID()
        const shortName = tc.name.includes('__')
          ? tc.name.split('__').slice(1).join('__')
          : tc.name
        emitTurn({
          type: 'status',
          phase: 'tool',
          detail: `Calling ${shortName}…`
        })
        emitTurn({
          type: 'tool_start',
          id,
          name: tc.name,
          arguments: tc.arguments
        })

        console.log(`[agent] tool start id=${tid} name=${tc.name}`)
        const toolStartedAt = Date.now()
        const { ok, result } = await mcpManager.callTool(tc.name, tc.arguments)
        const modelResult = truncateForModel(result)
        console.log(
          `[agent] tool end id=${tid} name=${tc.name} ok=${ok} +${ms(toolStartedAt)} resultChars=${result.length}` +
            (modelResult.length !== result.length
              ? ` modelChars=${modelResult.length}`
              : '')
        )
        emitTurn({
          type: 'tool_result',
          id,
          name: tc.name,
          ok,
          result
        })

        messages.push({
          role: 'tool',
          content: modelResult,
          tool_name: tc.name
        })
      }
    }

    console.log(
      `[agent] turn stopped id=${tid} total=${ms(turnStartedAt)} maxIterations=${MAX_TOOL_ITERATIONS}`
    )
    emitTurn({
      type: 'error',
      message: `Stopped after ${MAX_TOOL_ITERATIONS} tool iterations`
    })
  } catch (err) {
    if (abort.signal.aborted || activeTurnId !== turnId) {
      console.log(`[agent] aborted id=${tid} total=${ms(turnStartedAt)}`)
      emitTurn({ type: 'error', message: 'Aborted' })
    } else {
      const raw = err instanceof Error ? err.message : String(err)
      console.log(`[agent] error id=${tid} total=${ms(turnStartedAt)}: ${raw}`)
      emitTurn({
        type: 'error',
        message: raw
      })
    }
  } finally {
    if (activeTurnId === turnId) {
      finish()
      activeAbort = null
      activeTurnId = null
    }
  }
}

export type { ChatMessage }
