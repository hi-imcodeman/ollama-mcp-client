import { randomUUID } from 'crypto'
import type { ChatEvent, ChatMessage, ChatSendPayload } from '../shared/types'
import { getMaxToolIterations } from './config-store'
import { emitChatEvent } from './chat-events'
import { compactIfNeeded, shouldCompact } from './context-compact'
import {
  estimateChatMessagesTokens,
  estimateTokensFromChars,
  formatTokenCount
} from '../shared/contextUsage'
import {
  GENERATE_IMAGE_NAME,
  generateImageToolDefinition,
  runGenerateImageTool,
  shouldOfferGenerateImageTool
} from './image-gen-tool'
import { mcpManager } from './mcp-manager'
import { generateImageBase64 } from './ollama-image'
import {
  LOAD_SKILL_NAME,
  loadSkillByName,
  loadSkillTool,
  skillContextSystemMessage
} from './skills'
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

const WRAP_UP_USER_MESSAGE =
  "You've reached the maximum number of tool calls for this turn. Summarize what you accomplished, what's incomplete, and suggest next steps. Do not call any more tools."
/** Cap tool payloads sent back to the model; UI still gets the full result. */
const MAX_TOOL_RESULT_CHARS = 24_000
const MIN_NUM_PREDICT = 256
const PREDICT_RESERVE = 64

let activeAbort: AbortController | null = null
let activeTurnId: string | null = null

function emit(event: ChatEvent): void {
  emitChatEvent(event)
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

/**
 * Live meter for the next prompt. Prefer Ollama's prompt+eval counts when
 * history was not rewritten; char/4 estimates alone undercount (e.g. 1.5k vs 2.1k).
 */
function liveContextUsed(
  messages: ChatMessage[],
  extraTokens: number,
  measuredUsed?: number | null,
  historyRewritten = false
): number {
  const estimated = occupancyUsed(messages, extraTokens)
  if (historyRewritten) return estimated
  return Math.max(estimated, measuredUsed && measuredUsed > 0 ? measuredUsed : 0)
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

  const beforeUsed = liveContextUsed(messages, extraTokens, measuredUsed, false)
  const afterUsed = occupancyUsed(compact.messages, extraTokens)
  const delta = `${formatTokenCount(beforeUsed)} → ${formatTokenCount(afterUsed)}`

  console.log(
    `[agent] compacted id=${turnId.slice(0, 8)} before=${messages.length} after=${compact.messages.length} tokens ${delta}`
  )
  emitTurn({ type: 'compacted', messages: compact.messages })
  if (compact.summary) {
    emitTurn({
      type: 'notice',
      content: `Summarized earlier chat · ${delta}`,
      summary: compact.summary
    })
  } else {
    emitTurn({
      type: 'notice',
      content: `Trimmed earlier chat to fit context · ${delta}`
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

export function isAgentBusy(): boolean {
  return activeTurnId != null
}

export async function runAgentTurn(payload: ChatSendPayload): Promise<void> {
  const abort = new AbortController()
  activeAbort = abort
  const turnId = payload.turnId
  activeTurnId = turnId

  const emitTurn = (event: Exclude<ChatEvent, { type: 'user' }>): void => {
    emit({ ...event, turnId, sessionId: payload.sessionId })
  }

  let emittedDone = false
  const finish = (): void => {
    if (emittedDone) return
    emittedDone = true
    emitTurn({ type: 'done' })
  }

  const turnStartedAt = Date.now()
  const tid = shortTurnId(turnId)

  emitTurn({
    type: 'status',
    phase: 'thinking',
    detail: 'Processing your request…'
  })

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
    console.log(
      `[agent] turn start id=${tid} model=${payload.model} messages=${payload.messages.length} tools=0`
    )
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

  const skillTool = loadSkillTool()
  const baseTools = [...(skillTool ? [skillTool] : []), ...toolsFromMcp()]
  const offerImageTool = await shouldOfferGenerateImageTool(payload.model)
  const tools = offerImageTool
    ? [...baseTools, generateImageToolDefinition()]
    : baseTools

  console.log(
    `[agent] turn start id=${tid} model=${payload.model} messages=${payload.messages.length} tools=${tools.length}`
  )

  // Compact older history when near the context window (model history only).
  const toolOverhead = estimateToolOverhead(tools)
  let workingMessages = payload.messages
  try {
    const beforeCompact = workingMessages
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
        used: liveContextUsed(
          workingMessages,
          toolOverhead,
          payload.contextUsed,
          workingMessages !== beforeCompact
        ),
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

  const catalog = skillContextSystemMessage(payload.invokedSkill)
  const messages: OllamaChatMessage[] = [
    ...(catalog ? [{ role: 'system', content: catalog }] : []),
    ...toOllamaMessages(workingMessages)
  ]
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

  const maxToolIterations = getMaxToolIterations()

  const completeAssistantTurn = async (
    finalContent: string,
    promptEvalCount: number | undefined,
    evalCount: number | undefined,
    evalDurationNs: number | undefined,
    logLabel: string
  ): Promise<void> => {
    const tokensPerSec =
      evalCount != null && evalCount > 0 && evalDurationNs != null && evalDurationNs > 0
        ? evalCount / (evalDurationNs / 1e9)
        : undefined
    console.log(
      `[agent] ${logLabel} id=${tid} total=${ms(turnStartedAt)} contentChars=${finalContent.length}` +
        (tokensPerSec != null ? ` tok/s=${tokensPerSec.toFixed(1)}` : '')
    )
    const withReply: ChatMessage[] = finalContent
      ? [...workingMessages, { role: 'assistant', content: finalContent }]
      : workingMessages
    const used = (promptEvalCount ?? 0) + (evalCount ?? 0)
    emitTurn({
      type: 'assistant_done',
      content: finalContent,
      contextUsed: used > 0 ? used : occupancyUsed(withReply, toolOverhead),
      contextLimit: contextLimit ?? undefined,
      tokensPerSec
    })
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
          used: liveContextUsed(compacted, toolOverhead, used, compacted !== withReply),
          limit: contextLimit
        })
      }
    } catch (err) {
      console.warn('[agent] post-turn compact skipped:', err instanceof Error ? err.message : err)
      if (contextLimit) {
        emitTurn({
          type: 'context',
          used: liveContextUsed(withReply, toolOverhead, used, false),
          limit: contextLimit
        })
      }
    }
  }

  try {
    for (let iteration = 0; iteration < maxToolIterations; iteration++) {
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
      let thinkBuf = ''
      let contentBuf = ''
      let streamEmitTimer: ReturnType<typeof setImmediate> | null = null

      const flushStreamEmits = (): void => {
        if (streamEmitTimer != null) {
          clearImmediate(streamEmitTimer)
          streamEmitTimer = null
        }
        if (thinkBuf) {
          const text = thinkBuf
          thinkBuf = ''
          emitTurn({ type: 'thinking', content: text })
        }
        if (contentBuf) {
          const text = contentBuf
          contentBuf = ''
          emitTurn({ type: 'chunk', content: text })
        }
      }

      const queueStreamEmit = (): void => {
        if (streamEmitTimer == null) {
          streamEmitTimer = setImmediate(flushStreamEmits)
        }
      }

      const { content, toolCalls, promptEvalCount, evalCount, evalDurationNs } =
        await chatStream({
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
            thinkBuf += thinking
            queueStreamEmit()
          }

          const text = chunk.message?.content
          if (text) {
            if (!sawContent) {
              sawContent = true
              firstContentAt = Date.now()
              console.log(
                `[agent] iter=${iteration} first-content +${ms(iterStartedAt)} id=${tid}`
              )
              flushStreamEmits()
              emitTurn({
                type: 'status',
                phase: 'generating',
                detail: 'Writing a reply…'
              })
            }
            streamedContent += text
            contentBuf += text
            queueStreamEmit()
          }

          if (chunk.message?.tool_calls?.length && !sawContent) {
            if (firstToolCallAt == null) {
              firstToolCallAt = Date.now()
              console.log(
                `[agent] iter=${iteration} first-tool-call +${ms(iterStartedAt)} id=${tid}`
              )
              flushStreamEmits()
              emitTurn({
                type: 'status',
                phase: 'tool',
                detail: 'Choosing tools…'
              })
            }
          }
        }
      })

      if (abort.signal.aborted || activeTurnId !== turnId) {
        if (streamEmitTimer != null) {
          clearImmediate(streamEmitTimer)
          streamEmitTimer = null
        }
        thinkBuf = ''
        contentBuf = ''
        console.log(`[agent] aborted after stream iter=${iteration} id=${tid}`)
        emitTurn({ type: 'error', message: 'Aborted' })
        return
      }

      flushStreamEmits()

      const finalContent = content || streamedContent
      if (toolCalls.length > 0) {
        emitContext(promptEvalCount, evalCount)
      }
      const tokensPerSec =
        evalCount != null &&
        evalCount > 0 &&
        evalDurationNs != null &&
        evalDurationNs > 0
          ? evalCount / (evalDurationNs / 1e9)
          : undefined
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
            : '') +
          (tokensPerSec != null ? ` tok/s=${tokensPerSec.toFixed(1)}` : '')
      )

      if (toolCalls.length === 0) {
        await completeAssistantTurn(
          finalContent,
          promptEvalCount,
          evalCount,
          evalDurationNs,
          `turn done iterations=${iteration + 1}`
        )
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
        let ok: boolean
        let result: string
        if (tc.name === LOAD_SKILL_NAME) {
          ;({ ok, result } = loadSkillByName(String(tc.arguments.name ?? '')))
        } else if (tc.name === GENERATE_IMAGE_NAME) {
          emitTurn({
            type: 'status',
            phase: 'generating',
            detail: 'Generating image…'
          })
          const gen = await runGenerateImageTool(tc.arguments, abort.signal)
          if (gen.ok) {
            if (abort.signal.aborted || activeTurnId !== turnId) {
              ok = false
              result = 'Aborted'
            } else {
              emitTurn({
                type: 'assistant_images',
                images: [gen.imageBase64],
                mime: 'image/png'
              })
              ok = true
              result = gen.message
            }
          } else {
            ok = false
            result = gen.message
          }
        } else {
          ;({ ok, result } = await mcpManager.callTool(tc.name, tc.arguments))
        }
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

    if (abort.signal.aborted || activeTurnId !== turnId) {
      emitTurn({ type: 'error', message: 'Aborted' })
      return
    }

    console.log(
      `[agent] tool limit reached id=${tid} maxIterations=${maxToolIterations} wrap-up=true`
    )
    messages.push({ role: 'user', content: WRAP_UP_USER_MESSAGE })

    emitTurn({
      type: 'status',
      phase: 'synthesizing',
      detail: 'Summarizing progress…'
    })

    let wrapContent = ''
    let wrapThinkBuf = ''
    let wrapContentBuf = ''
    let wrapEmitTimer: ReturnType<typeof setImmediate> | null = null

    const flushWrapEmits = (): void => {
      if (wrapEmitTimer != null) {
        clearImmediate(wrapEmitTimer)
        wrapEmitTimer = null
      }
      if (wrapThinkBuf) {
        const text = wrapThinkBuf
        wrapThinkBuf = ''
        emitTurn({ type: 'thinking', content: text })
      }
      if (wrapContentBuf) {
        const text = wrapContentBuf
        wrapContentBuf = ''
        emitTurn({ type: 'chunk', content: text })
      }
    }

    const queueWrapEmit = (): void => {
      if (wrapEmitTimer == null) {
        wrapEmitTimer = setImmediate(flushWrapEmits)
      }
    }

    const {
      content: wrapReply,
      promptEvalCount: wrapPromptEval,
      evalCount: wrapEval,
      evalDurationNs: wrapEvalDuration
    } = await chatStream({
      model: payload.model,
      messages,
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
          wrapThinkBuf += thinking
          queueWrapEmit()
        }
        const text = chunk.message?.content
        if (text) {
          wrapContent += text
          wrapContentBuf += text
          queueWrapEmit()
        }
      }
    })

    if (wrapEmitTimer != null) {
      clearImmediate(wrapEmitTimer)
      wrapEmitTimer = null
    }
    flushWrapEmits()

    if (abort.signal.aborted || activeTurnId !== turnId) {
      emitTurn({ type: 'error', message: 'Aborted' })
      return
    }

    await completeAssistantTurn(
      wrapReply || wrapContent,
      wrapPromptEval,
      wrapEval,
      wrapEvalDuration,
      `wrap-up done maxIterations=${maxToolIterations}`
    )
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
