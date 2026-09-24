import type { ChatEvent, ChatMessage, UiMessage } from '../../../shared/types'
import {
  closeStreamingThinking,
  closeToolMessage,
  segmentDurationMs
} from './segmentTiming'

export type BackgroundSessionTurn = {
  messages: UiMessage[]
  history: ChatMessage[]
  turnStartedAt: number
  turnModel: string | null
}

function uid(): string {
  return crypto.randomUUID()
}

function nowIso(): string {
  return new Date().toISOString()
}

export function applyBackgroundChatEvent(
  event: ChatEvent,
  state: BackgroundSessionTurn,
  onPersist: (messages: UiMessage[], history: ChatMessage[]) => void,
  showThinking = false
): void {
  const { turnStartedAt, turnModel } = state
  let { messages, history } = state

  const persist = (): void => {
    state.messages = messages
    state.history = history
    onPersist(messages, history)
  }

  const clearQueuedLabels = (): void => {
    if (!messages.some((m) => m.kind === 'user' && m.queueStatus === 'queued')) return
    messages = messages.map((m) =>
      m.kind === 'user' && m.queueStatus === 'queued'
        ? { ...m, queueStatus: undefined }
        : m
    )
    state.messages = messages
  }

  if (event.type === 'thinking') {
    clearQueuedLabels()
    if (!showThinking || !event.content) return
    let next = [...messages]
    const last = next[next.length - 1]
    if (last?.kind === 'thinking' && last.streaming) {
      next[next.length - 1] = {
        ...last,
        content: last.content + event.content
      }
    } else {
      next.push({
        kind: 'thinking',
        id: uid(),
        content: event.content,
        createdAt: nowIso(),
        streaming: true,
        model: turnModel ?? undefined,
        startedAt: Date.now()
      })
    }
    messages = next
    state.messages = messages
    return
  }

  if (event.type === 'chunk' || event.type === 'status') {
    if (event.type === 'status') clearQueuedLabels()
    return
  }

  if (event.type === 'assistant_done') {
    if (event.content) {
      const last = history[history.length - 1]
      if (last?.role !== 'assistant' || last.content !== event.content) {
        history = [...history, { role: 'assistant', content: event.content }]
      }
    }
    const responseMs = Date.now() - turnStartedAt
    const finishedAt = nowIso()
    let next = closeStreamingThinking(messages, turnStartedAt)
    const last = next[next.length - 1]
    if (last?.kind === 'assistant' && last.streaming) {
      next[next.length - 1] = {
        ...last,
        content: event.content || last.content,
        streaming: false,
        createdAt: finishedAt,
        durationMs: segmentDurationMs(last.startedAt),
        responseMs,
        contextUsed: event.contextUsed ?? last.contextUsed,
        contextLimit: event.contextLimit ?? last.contextLimit,
        tokensPerSec: event.tokensPerSec ?? last.tokensPerSec,
        tokenUsage: event.tokenUsage ?? last.tokenUsage,
        multiCallTurn: event.multiCallTurn ?? last.multiCallTurn
      }
    } else if (event.content) {
      next.push({
        kind: 'assistant',
        id: uid(),
        content: event.content,
        createdAt: finishedAt,
        streaming: false,
        responseMs,
        model: turnModel ?? undefined,
        contextUsed: event.contextUsed,
        contextLimit: event.contextLimit,
        tokensPerSec: event.tokensPerSec,
        tokenUsage: event.tokenUsage,
        multiCallTurn: event.multiCallTurn
      })
    }
    messages = next
    persist()
    return
  }

  if (event.type === 'assistant_images') {
    const mime = event.mime ?? 'image/png'
    const dataUrls = event.images.map((b64) =>
      b64.startsWith('data:') ? b64 : `data:${mime};base64,${b64}`
    )
    history = [
      ...history,
      {
        role: 'assistant',
        content: 'An image was generated and displayed to the user.'
      }
    ]
    const responseMs = Date.now() - turnStartedAt
    const finishedAt = nowIso()
    let next = closeStreamingThinking(messages, turnStartedAt)
    const last = next[next.length - 1]
    if (last?.kind === 'assistant' && last.streaming) {
      next[next.length - 1] = {
        ...last,
        content: last.content || '',
        images: dataUrls,
        imageModel: event.imageModel,
        streaming: false,
        createdAt: finishedAt,
        durationMs: segmentDurationMs(last.startedAt),
        responseMs,
        contextUsed: event.contextUsed ?? last.contextUsed,
        contextLimit: event.contextLimit ?? last.contextLimit,
        tokenUsage: event.tokenUsage ?? last.tokenUsage
      }
    } else {
      next.push({
        kind: 'assistant',
        id: uid(),
        content: '',
        images: dataUrls,
        imageModel: event.imageModel,
        createdAt: finishedAt,
        streaming: false,
        responseMs,
        model: turnModel ?? undefined,
        contextUsed: event.contextUsed,
        contextLimit: event.contextLimit,
        tokenUsage: event.tokenUsage
      })
    }
    messages = next
    persist()
    return
  }

  if (event.type === 'tool_start') {
    const responseMs = Date.now() - turnStartedAt
    let next = closeStreamingThinking(messages, turnStartedAt)
    const last = next[next.length - 1]
    if (last?.kind === 'assistant' && last.streaming) {
      next = [
        ...next.slice(0, -1),
        {
          ...last,
          streaming: false,
          createdAt: nowIso(),
          durationMs: segmentDurationMs(last.startedAt),
          responseMs: last.responseMs ?? responseMs
        }
      ]
    }
    next.push({
      kind: 'tool',
      id: event.id,
      name: event.name,
      arguments: event.arguments,
      status: 'running',
      createdAt: nowIso(),
      model: turnModel ?? undefined,
      startedAt: Date.now()
    })
    messages = next
    persist()
    return
  }

  if (event.type === 'tool_result') {
    messages = messages.map((m) =>
      m.kind === 'tool' && m.id === event.id
        ? closeToolMessage(
            {
              ...m,
              status: event.ok ? 'done' : 'error',
              result: event.result
            },
            turnStartedAt
          )
        : m
    )
    persist()
    return
  }

  if (event.type === 'error') {
    if (event.message === 'Aborted') return
    messages = [
      ...messages,
      {
        kind: 'error',
        id: uid(),
        content: event.message,
        createdAt: nowIso(),
        model: turnModel ?? undefined
      }
    ]
    persist()
    return
  }

  if (event.type === 'compacted') {
    history = event.messages
    persist()
    return
  }

  if (event.type === 'notice') {
    messages = [
      ...messages,
      {
        kind: 'notice',
        id: uid(),
        content: event.content,
        createdAt: nowIso(),
        summary: event.summary
      }
    ]
    persist()
    return
  }

  if (event.type === 'done') {
    const responseMs = Date.now() - turnStartedAt
    const finishedAt = nowIso()
    messages = closeStreamingThinking(
      messages.map((m) =>
        m.kind === 'assistant' && m.streaming
          ? {
              ...m,
              streaming: false,
              createdAt: finishedAt,
              durationMs: segmentDurationMs(m.startedAt),
              responseMs: m.responseMs ?? responseMs
            }
          : m
      ),
      turnStartedAt
    )
    persist()
  }
}

export function createBackgroundSessionTurn(
  messages: UiMessage[],
  history: ChatMessage[],
  turnModel: string | null
): BackgroundSessionTurn {
  return {
    messages: [...messages],
    history: [...history],
    turnStartedAt: Date.now(),
    turnModel
  }
}
