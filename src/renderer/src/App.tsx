import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityPhase,
  ChatEvent,
  ChatMessage,
  ChatQueueState,
  ChatSession,
  LlmProvider,
  McpToolInfo,
  OllamaModel,
  OpenAiStatus,
  ScheduleNotificationPayload,
  SessionQueueStatus,
  TelegramStatus,
  UiMessage
} from '../../shared/types'
import { isOpenAiImageGenModel } from '../../shared/openai-models'
import type { ServerWithStatus } from '../../preload/index'
import type { ActivityState } from './components/ActivityIndicator'
import { Chat } from './components/Chat'
import { McpCatalogPage } from './components/McpCatalogPage'
import { ModelsPage } from './components/ModelsPage'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { SchedulesPage } from './components/SchedulesPage'
import { SkillsPage } from './components/SkillsPage'
import {
  applyBackgroundChatEvent,
  createBackgroundSessionTurn,
  type BackgroundSessionTurn
} from './lib/backgroundChatEvents'
import {
  closeStreamingThinking,
  closeToolMessage,
  segmentDurationMs
} from './lib/segmentTiming'

function uid(): string {
  return crypto.randomUUID()
}

function nowIso(): string {
  return new Date().toISOString()
}

const IDLE_ACTIVITY: ActivityState = { phase: 'idle' }

function sessionQueueStatus(
  sessionId: string,
  state: ChatQueueState
): SessionQueueStatus {
  if (state.running?.sessionId === sessionId) return 'running'
  if (state.queued.some((q) => q.sessionId === sessionId)) return 'queued'
  return 'idle'
}

function titleFromPrompt(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'New chat'
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned
}

export default function App(): React.JSX.Element {
  const [servers, setServers] = useState<ServerWithStatus[]>([])
  const [tools, setTools] = useState<McpToolInfo[]>([])
  const [models, setModels] = useState<OllamaModel[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [ollamaOk, setOllamaOk] = useState(false)
  const [ollamaError, setOllamaError] = useState<string | undefined>()
  const [imageGenSupported, setImageGenSupported] = useState(true)
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434')
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('ollama')
  const [openaiEnabled, setOpenaiEnabled] = useState(false)
  const [openaiApiKeyDraft, setOpenaiApiKeyDraft] = useState('')
  const [openaiStatus, setOpenaiStatus] = useState<OpenAiStatus>({
    enabled: false,
    validationOk: false,
    validationError: null,
    catalogCount: 0,
    enabledCount: 0
  })
  const [openaiCatalog, setOpenaiCatalog] = useState<
    import('../../shared/types').OpenAiModelEntry[]
  >([])
  const [openaiModelEnabled, setOpenaiModelEnabled] = useState<Record<string, boolean>>(
    {}
  )
  const [selectedOpenAiModel, setSelectedOpenAiModel] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState<ActivityState>(IDLE_ACTIVITY)
  const [showThinking, setShowThinking] = useState(false)
  const [maxToolIterations, setMaxToolIterations] = useState(30)
  const [defaultImageModel, setDefaultImageModel] = useState<string | null>(null)
  const [telegramEnabled, setTelegramEnabled] = useState(false)
  const [telegramAllowedUserIds, setTelegramAllowedUserIds] = useState<number[]>(
    []
  )
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus>({
    running: false
  })
  const [telegramTokenDraft, setTelegramTokenDraft] = useState('')
  const [view, setView] = useState<
    'chat' | 'models' | 'mcp' | 'skills' | 'schedules' | 'settings'
  >('chat')
  const [modelsVisited, setModelsVisited] = useState(false)
  const [mcpVisited, setMcpVisited] = useState(false)
  const [skillsVisited, setSkillsVisited] = useState(false)
  const [schedulesVisited, setSchedulesVisited] = useState(false)
  const [settingsVisited, setSettingsVisited] = useState(false)
  const [scheduleToast, setScheduleToast] = useState<ScheduleNotificationPayload | null>(
    null
  )
  const [queueState, setQueueState] = useState<ChatQueueState>({
    running: null,
    queued: []
  })
  const [contextUsage, setContextUsage] = useState<{
    used: number
    limit: number
  } | null>(null)

  const historyRef = useRef<ChatMessage[]>([])
  const messagesRef = useRef<UiMessage[]>([])
  const activeSessionIdRef = useRef<string | null>(null)
  const sessionTitleRef = useRef('New chat')
  const persistTimer = useRef<number | null>(null)
  /** Bumped on switch/new/abort so late stream events never touch another session. */
  const chatEpochRef = useRef(0)
  const activeTurnIdRef = useRef<string | null>(null)
  const turnStartedAtRef = useRef<number | null>(null)
  const turnModelRef = useRef<string | null>(null)
  const selectedModelRef = useRef<string | null>(null)
  const showThinkingRef = useRef(false)
  const sessionsRef = useRef<ChatSession[]>([])
  const backgroundSessionsRef = useRef<Map<string, BackgroundSessionTurn>>(new Map())
  const writeSessionRef = useRef<
    (
      id: string,
      uiMessages: UiMessage[],
      history: ChatMessage[],
      title?: string
    ) => Promise<void>
  >(async () => {})
  const persistSessionRef = useRef<
    (
      id: string,
      uiMessages: UiMessage[],
      history: ChatMessage[],
      title?: string
    ) => void
  >(() => {})
  const pendingAiTitleRef = useRef<{
    sessionId: string
    prompt: string
    turnId: string
  } | null>(null)
  const titleGenEpochRef = useRef(0)
  const requestAiTitleRef = useRef<() => void>(() => {})
  /** Coalesce high-frequency stream IPC so React does not nest 50+ setStates. */
  const streamBufRef = useRef<{
    thinking: string
    chunk: string
    sessionId: string | null
    turnId: string | null
    raf: number | null
  }>({
    thinking: '',
    chunk: '',
    sessionId: null,
    turnId: null,
    raf: null
  })
  const queueStateRef = useRef<ChatQueueState>({ running: null, queued: [] })

  const syncMessages = useCallback((next: UiMessage[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  const applySessionsState = useCallback(
    (state: { sessions: ChatSession[]; activeSessionId: string | null }) => {
      setSessions(state.sessions)
      setActiveSessionId(state.activeSessionId)
      activeSessionIdRef.current = state.activeSessionId
      const active = state.sessions.find((s) => s.id === state.activeSessionId)
      if (active) {
        messagesRef.current = active.uiMessages
        setMessages(active.uiMessages)
        historyRef.current = active.history
        sessionTitleRef.current = active.title
      } else {
        messagesRef.current = []
        setMessages([])
        historyRef.current = []
        sessionTitleRef.current = 'New chat'
      }
    },
    []
  )

  const writeSession = useCallback(
    async (
      id: string,
      uiMessages: UiMessage[],
      history: ChatMessage[],
      title?: string
    ): Promise<void> => {
      try {
        const patch: Partial<
          Pick<ChatSession, 'title' | 'uiMessages' | 'history'>
        > = {
          uiMessages,
          history
        }
        if (title !== undefined) patch.title = title
        const state = await window.api.sessions.update(id, patch)
        // Refresh list only — never reload the open chat from this response
        // (that races with an in-progress switch).
        setSessions(state.sessions)
      } catch (err) {
        console.error('Failed to persist session', err)
      }
    },
    []
  )

  const persistSession = useCallback(
    (
      id: string,
      uiMessages: UiMessage[],
      history: ChatMessage[],
      title?: string
    ) => {
      if (!id) return
      if (title !== undefined && id === activeSessionIdRef.current) {
        sessionTitleRef.current = title
      }

      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current)
      }
      persistTimer.current = window.setTimeout(() => {
        persistTimer.current = null
        const titleNow =
          id === activeSessionIdRef.current
            ? sessionTitleRef.current
            : undefined
        void writeSession(id, uiMessages, history, titleNow)
      }, 250)
    },
    [writeSession]
  )

  useEffect(() => {
    persistSessionRef.current = persistSession
  }, [persistSession])

  const applyGeneratedTitle = useCallback((id: string, title: string) => {
    setSessions((prev) =>
      prev.map((session) => (session.id === id ? { ...session, title } : session))
    )
    if (id === activeSessionIdRef.current) {
      sessionTitleRef.current = title
    }
  }, [])

  const requestAiTitle = useCallback((): void => {
    const pending = pendingAiTitleRef.current
    if (!pending) return
    pendingAiTitleRef.current = null
    const epoch = titleGenEpochRef.current
    void (async () => {
      try {
        const title = await window.api.sessions.generateTitle(
          pending.sessionId,
          pending.prompt
        )
        if (epoch !== titleGenEpochRef.current) return
        applyGeneratedTitle(pending.sessionId, title)
      } catch (err) {
        console.error('Failed to generate session title', err)
      }
    })()
  }, [applyGeneratedTitle])

  const cancelAiTitle = useCallback((): void => {
    pendingAiTitleRef.current = null
    titleGenEpochRef.current += 1
  }, [])

  useEffect(() => {
    requestAiTitleRef.current = requestAiTitle
  }, [requestAiTitle])

  useEffect(() => {
    showThinkingRef.current = showThinking
  }, [showThinking])

  useEffect(() => {
    selectedModelRef.current = selectedModel
  }, [selectedModel])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    writeSessionRef.current = writeSession
  }, [writeSession])

  const flushActiveSession = useCallback(async (): Promise<void> => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    const id = activeSessionIdRef.current
    if (!id) return
    await writeSession(
      id,
      messagesRef.current,
      historyRef.current,
      sessionTitleRef.current
    )
  }, [writeSession])

  const bumpChatEpoch = useCallback(() => {
    chatEpochRef.current += 1
    const buf = streamBufRef.current
    if (buf.raf != null) {
      window.cancelAnimationFrame(buf.raf)
      buf.raf = null
    }
    buf.thinking = ''
    buf.chunk = ''
    buf.sessionId = null
    buf.turnId = null
  }, [])

  const refreshServers = useCallback(async () => {
    const list = await window.api.mcp.listServers()
    setServers(list)
    const t = await window.api.mcp.listTools()
    setTools(t)
  }, [])

  const refreshOpenAiStatus = useCallback(async () => {
    setOpenaiStatus(await window.api.openai.getStatus())
  }, [])

  const refreshModelsForProvider = useCallback(
    async (provider: LlmProvider) => {
      if (provider === 'openai') {
        try {
          const list = await window.api.openai.listChatModels()
          setModels(list)
          const names = list.map((m) => m.name)
          setSelectedModel((current) => {
            if (current && names.includes(current)) return current
            const next = names[0] ?? null
            if (next) {
              void window.api.setSelectedModelForProvider('openai', next)
            }
            return next
          })
        } catch {
          setModels([])
        }
        return
      }
      const status = await window.api.ollama.getStatus()
      if (!status.ok) {
        setModels([])
        return
      }
      const list = await window.api.ollama.listModels()
      setModels(list)
      const names = list.map((m) => m.name)
      setSelectedModel((current) => {
        if (current && names.includes(current)) return current
        const next = names[0] ?? null
        if (next) {
          void window.api.setSelectedModelForProvider('ollama', next)
        }
        return next
      })
    },
    []
  )

  const applyConfig = useCallback(
    async (config: Awaited<ReturnType<typeof window.api.getConfig>>) => {
      setBaseUrl(config.ollamaBaseUrl)
      setLlmProvider(config.llmProvider)
      setOpenaiEnabled(config.openaiEnabled)
      setOpenaiApiKeyDraft(config.openaiApiKey ?? '')
      setOpenaiCatalog(config.openaiModelsCatalog)
      setOpenaiModelEnabled(config.openaiModelEnabled)
      setSelectedOpenAiModel(config.selectedModelByProvider.openai)
      setSelectedModel(config.selectedModel)
      setShowThinking(Boolean(config.showThinking))
      showThinkingRef.current = Boolean(config.showThinking)
      setMaxToolIterations(config.maxToolIterations)
      setDefaultImageModel(config.defaultImageModel ?? null)
      setTelegramEnabled(Boolean(config.telegramEnabled))
      setTelegramAllowedUserIds(config.telegramAllowedUserIds)
      await refreshOpenAiStatus()
      await refreshModelsForProvider(config.llmProvider)
    },
    [refreshModelsForProvider, refreshOpenAiStatus]
  )

  const refreshOllama = useCallback(async () => {
    const status = await window.api.ollama.getStatus()
    setOllamaOk(status.ok)
    setOllamaError(status.error)
    setBaseUrl(status.baseUrl)
    setImageGenSupported(status.imageGenSupported !== false)
    if (status.ok && llmProvider === 'ollama') {
      try {
        await refreshModelsForProvider('ollama')
      } catch (err) {
        setOllamaOk(false)
        setOllamaError(err instanceof Error ? err.message : String(err))
      }
    } else if (llmProvider === 'ollama') {
      setModels([])
    }
  }, [llmProvider, refreshModelsForProvider])

  useEffect(() => {
    void (async () => {
      const config = await window.api.getConfig()
      setTelegramStatus(await window.api.telegram.getStatus())
      const sessionState = await window.api.sessions.list()
      applySessionsState(sessionState)
      await refreshServers()
      await applyConfig(config)
      const status = await window.api.ollama.getStatus()
      setOllamaOk(status.ok)
      setOllamaError(status.error)
      setImageGenSupported(status.imageGenSupported !== false)
    })()
  }, [applyConfig, applySessionsState, refreshServers])

  useEffect(() => {
    queueStateRef.current = queueState
  }, [queueState])

  const clearQueuedLabels = useCallback((sessionId: string): void => {
    if (sessionId !== activeSessionIdRef.current) return
    const next = messagesRef.current.map((m) =>
      m.kind === 'user' && m.queueStatus === 'queued'
        ? { ...m, queueStatus: undefined }
        : m
    )
    syncMessages(next)
    persistSessionRef.current(sessionId, next, historyRef.current)
  }, [syncMessages])

  const adoptRunningTurn = useCallback(
    (sessionId: string, turnId: string): void => {
      if (sessionId !== activeSessionIdRef.current) return
      activeTurnIdRef.current = turnId
      turnStartedAtRef.current = Date.now()
      turnModelRef.current = selectedModelRef.current
      setBusy(true)
      setActivity({
        phase: 'thinking',
        detail: 'Waiting for the model…',
        thinking: '',
        startedAt: Date.now()
      })
      clearQueuedLabels(sessionId)
    },
    [clearQueuedLabels]
  )

  useEffect(() => {
    void window.api.queue.getState().then((state) => {
      setQueueState(state)
      queueStateRef.current = state
    })
    const unsubQueue = window.api.queue.onChanged((state) => {
      setQueueState(state)
      queueStateRef.current = state
      const activeId = activeSessionIdRef.current
      if (activeId && state.running?.sessionId === activeId) {
        adoptRunningTurn(activeId, state.running.turnId)
      }
    })
    return unsubQueue
  }, [adoptRunningTurn])

  useEffect(() => {
    const unsubSchedules = window.api.schedules.onNotification((payload) => {
      setScheduleToast(payload)
    })

    const unsub = window.api.sessions.onChanged((state) => {
      applySessionsState(state)
    })
    return () => {
      unsubSchedules()
      unsub()
    }
  }, [applySessionsState])

  useEffect(() => {
    if (!scheduleToast) return
    const timer = window.setTimeout(() => setScheduleToast(null), 8000)
    return () => window.clearTimeout(timer)
  }, [scheduleToast])

  useEffect(() => {
    const buf = streamBufRef.current

    const applyThinkingDelta = (content: string): void => {
      setActivity((prev) => ({
        ...prev,
        phase: 'thinking',
        detail: prev.detail ?? 'Model is reasoning…',
        thinking: (prev.thinking ?? '') + content,
        startedAt: prev.startedAt ?? Date.now()
      }))
      if (!showThinkingRef.current) return
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.kind === 'thinking' && last.streaming) {
          next[next.length - 1] = {
            ...last,
            content: last.content + content
          }
        } else {
          next.push({
            kind: 'thinking',
            id: uid(),
            content,
            createdAt: nowIso(),
            streaming: true,
            model: turnModelRef.current ?? undefined,
            startedAt: Date.now()
          })
        }
        messagesRef.current = next
        return next
      })
    }

    const applyChunkDelta = (content: string): void => {
      setActivity((prev) =>
        prev.phase === 'generating'
          ? prev
          : {
              ...prev,
              phase: 'generating' as ActivityPhase,
              detail: 'Writing a reply…',
              startedAt: prev.startedAt ?? Date.now()
            }
      )
      setMessages((prev) => {
        let next = closeStreamingThinking(prev, turnStartedAtRef.current)
        next = [...next]
        const last = next[next.length - 1]
        if (last?.kind === 'assistant' && last.streaming) {
          next[next.length - 1] = {
            ...last,
            content: last.content + content
          }
        } else {
          next.push({
            kind: 'assistant',
            id: uid(),
            content,
            createdAt: nowIso(),
            streaming: true,
            model: turnModelRef.current ?? undefined,
            startedAt: Date.now()
          })
        }
        messagesRef.current = next
        return next
      })
    }

    const flushStreamBuf = (): void => {
      if (buf.raf != null) {
        window.cancelAnimationFrame(buf.raf)
        buf.raf = null
      }
      const thinking = buf.thinking
      const chunk = buf.chunk
      const sessionId = buf.sessionId
      const turnId = buf.turnId
      buf.thinking = ''
      buf.chunk = ''
      if (!thinking && !chunk) return
      if (!sessionId || !turnId) return
      if (sessionId !== activeSessionIdRef.current) return
      if (turnId !== activeTurnIdRef.current) return
      if (thinking) applyThinkingDelta(thinking)
      if (chunk) applyChunkDelta(chunk)
    }

    const scheduleStreamFlush = (sessionId: string, turnId: string): void => {
      buf.sessionId = sessionId
      buf.turnId = turnId
      if (buf.raf != null) return
      buf.raf = window.requestAnimationFrame(flushStreamBuf)
    }

    const unsub = window.api.chat.onEvent((event: ChatEvent) => {
      if (
        (event.type === 'done' || event.type === 'error') &&
        event.turnId &&
        pendingAiTitleRef.current?.turnId === event.turnId
      ) {
        requestAiTitleRef.current()
      }

      const eventSessionId = event.sessionId

      if (event.turnId && eventSessionId) {
        if (eventSessionId !== activeSessionIdRef.current) {
          let bg = backgroundSessionsRef.current.get(eventSessionId)
          if (!bg) {
            const session = sessionsRef.current.find((s) => s.id === eventSessionId)
            if (!session) return
            bg = createBackgroundSessionTurn(
              session.uiMessages,
              session.history,
              selectedModelRef.current
            )
            backgroundSessionsRef.current.set(eventSessionId, bg)
          }
          applyBackgroundChatEvent(
            event,
            bg,
            (ui, hist) => {
              void writeSessionRef.current(eventSessionId, ui, hist)
            },
            showThinkingRef.current
          )
          if (event.type === 'done' || event.type === 'error') {
            backgroundSessionsRef.current.delete(eventSessionId)
          }
          return
        }
      }

      const sessionId = activeSessionIdRef.current
      if (!sessionId) return

      // Adopt in-flight turns only for the session currently open in the UI.
      if (
        event.turnId &&
        eventSessionId === sessionId &&
        !activeTurnIdRef.current &&
        event.type !== 'user' &&
        event.type !== 'done'
      ) {
        activeTurnIdRef.current = event.turnId
        turnStartedAtRef.current = Date.now()
        turnModelRef.current = selectedModelRef.current
        setBusy(true)
        setActivity({
          phase: 'thinking',
          detail: 'Waiting for the model…',
          thinking: '',
          startedAt: Date.now()
        })
      }

      const turnOk =
        Boolean(event.turnId) &&
        Boolean(activeTurnIdRef.current) &&
        event.turnId === activeTurnIdRef.current &&
        (!eventSessionId || eventSessionId === sessionId)

      const stillCurrent = (): boolean =>
        turnOk && sessionId === activeSessionIdRef.current

      if (event.type === 'thinking' || event.type === 'chunk') {
        if (!stillCurrent() || !event.turnId) return
        if (event.type === 'thinking') buf.thinking += event.content
        else buf.chunk += event.content
        scheduleStreamFlush(sessionId, event.turnId)
        return
      }

      flushStreamBuf()

      const endBusy = (): void => {
        if (!turnOk) return
        setBusy(false)
        setActivity(IDLE_ACTIVITY)
        // Keep activeTurnId until `done` so a follow-up done event still matches.
        if (event.type === 'done' || event.type === 'error') {
          activeTurnIdRef.current = null
        }
      }

      if (event.type === 'status') {
        if (!stillCurrent()) return
        setActivity((prev) => ({
          phase: event.phase,
          detail: event.detail,
          thinking: prev.thinking,
          startedAt: prev.startedAt ?? Date.now()
        }))
      } else if (event.type === 'assistant_done') {
        if (!stillCurrent()) return
        endBusy()
        if (event.content) {
          const last = historyRef.current[historyRef.current.length - 1]
          if (
            last?.role !== 'assistant' ||
            last.content !== event.content
          ) {
            historyRef.current = [
              ...historyRef.current,
              { role: 'assistant', content: event.content }
            ]
          }
        }
        const historySnapshot = historyRef.current
        const responseMs =
          turnStartedAtRef.current != null
            ? Date.now() - turnStartedAtRef.current
            : undefined
        const finishedAt = nowIso()
        setMessages((prev) => {
          if (sessionId !== activeSessionIdRef.current) return prev
          const next = closeStreamingThinking(prev, turnStartedAtRef.current)
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
              model: turnModelRef.current ?? undefined,
              contextUsed: event.contextUsed,
              contextLimit: event.contextLimit,
              tokensPerSec: event.tokensPerSec,
              tokenUsage: event.tokenUsage,
              multiCallTurn: event.multiCallTurn
            })
          }
          messagesRef.current = next
          persistSessionRef.current(sessionId, next, historySnapshot)
          return next
        })
      } else if (event.type === 'assistant_images') {
        if (!stillCurrent()) return
        endBusy()
        const mime = event.mime ?? 'image/png'
        const dataUrls = event.images.map((b64) =>
          b64.startsWith('data:') ? b64 : `data:${mime};base64,${b64}`
        )
        historyRef.current = [
          ...historyRef.current,
          {
            role: 'assistant',
            content: 'An image was generated and displayed to the user.'
          }
        ]
        const historySnapshot = historyRef.current
        const responseMs =
          turnStartedAtRef.current != null
            ? Date.now() - turnStartedAtRef.current
            : undefined
        const finishedAt = nowIso()
        setMessages((prev) => {
          if (sessionId !== activeSessionIdRef.current) return prev
          const next = closeStreamingThinking(prev, turnStartedAtRef.current)
          const last = next[next.length - 1]
          if (last?.kind === 'assistant' && last.streaming) {
            next[next.length - 1] = {
              ...last,
              content: last.content || '',
              images: dataUrls,
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
              createdAt: finishedAt,
              streaming: false,
              responseMs,
              model: turnModelRef.current ?? undefined,
              contextUsed: event.contextUsed,
              contextLimit: event.contextLimit,
              tokenUsage: event.tokenUsage
            })
          }
          messagesRef.current = next
          persistSessionRef.current(sessionId, next, historySnapshot)
          return next
        })
      } else if (event.type === 'tool_start') {
        if (!stillCurrent()) return
        setActivity((prev) => ({
          phase: 'tool',
          detail: `Calling ${event.name.includes('__') ? event.name.split('__').slice(1).join('__') : event.name}…`,
          thinking: prev.thinking,
          startedAt: prev.startedAt ?? Date.now()
        }))
        setMessages((prev) => {
          if (!stillCurrent()) return prev
          const closed = closeStreamingThinking(prev, turnStartedAtRef.current)
          const last = closed[closed.length - 1]
          const responseMs =
            turnStartedAtRef.current != null
              ? Date.now() - turnStartedAtRef.current
              : undefined
          const withClosed =
            last?.kind === 'assistant' && last.streaming
              ? [
                  ...closed.slice(0, -1),
                  {
                    ...last,
                    streaming: false,
                    createdAt: nowIso(),
                    durationMs: segmentDurationMs(last.startedAt),
                    responseMs: last.responseMs ?? responseMs
                  }
                ]
              : [...closed]
          withClosed.push({
            kind: 'tool',
            id: event.id,
            name: event.name,
            arguments: event.arguments,
            status: 'running',
            createdAt: nowIso(),
            model: turnModelRef.current ?? undefined,
            startedAt: Date.now()
          })
          messagesRef.current = withClosed
          persistSessionRef.current(sessionId, withClosed, historyRef.current)
          return withClosed
        })
      } else if (event.type === 'tool_result') {
        if (!stillCurrent()) return
        setMessages((prev) => {
          if (!stillCurrent()) return prev
          const next = prev.map((m) =>
            m.kind === 'tool' && m.id === event.id
              ? closeToolMessage(
                  {
                    ...m,
                    status: event.ok ? ('done' as const) : ('error' as const),
                    result: event.result
                  },
                  turnStartedAtRef.current
                )
              : m
          )
          messagesRef.current = next
          persistSessionRef.current(sessionId, next, historyRef.current)
          return next
        })
      } else if (event.type === 'error') {
        if (!stillCurrent()) return
        endBusy()
        if (event.message === 'Aborted') return
        setMessages((prev) => {
          if (sessionId !== activeSessionIdRef.current) return prev
          const next = [
            ...prev,
            {
              kind: 'error' as const,
              id: uid(),
              content: event.message,
              createdAt: nowIso(),
              model: turnModelRef.current ?? undefined
            }
          ]
          messagesRef.current = next
          persistSessionRef.current(sessionId, next, historyRef.current)
          return next
        })
      } else if (event.type === 'context') {
        if (!stillCurrent()) return
        setContextUsage({
          used: event.used,
          limit: event.limit
        })
      } else if (event.type === 'compacted') {
        if (!stillCurrent()) return
        historyRef.current = event.messages
        persistSessionRef.current(
          sessionId,
          messagesRef.current,
          event.messages
        )
      } else if (event.type === 'provider_fallback') {
        if (!stillCurrent()) return
        setMessages((prev) => {
          if (!stillCurrent()) return prev
          const notice = {
            kind: 'notice' as const,
            id: uid(),
            content: event.message,
            createdAt: nowIso()
          }
          const next = [...prev, notice]
          messagesRef.current = next
          persistSessionRef.current(sessionId, next, historyRef.current)
          return next
        })
      } else if (event.type === 'notice') {
        if (!stillCurrent()) return
        setMessages((prev) => {
          if (!stillCurrent()) return prev
          const notice = {
            kind: 'notice' as const,
            id: uid(),
            content: event.content,
            createdAt: nowIso(),
            summary: event.summary
          }
          const next = [...prev, notice]
          messagesRef.current = next
          persistSessionRef.current(sessionId, next, historyRef.current)
          return next
        })
      } else if (event.type === 'done') {
        if (!stillCurrent()) return
        endBusy()
        const responseMs =
          turnStartedAtRef.current != null
            ? Date.now() - turnStartedAtRef.current
            : undefined
        const finishedAt = nowIso()
        setMessages((prev) => {
          if (sessionId !== activeSessionIdRef.current) return prev
          const next = closeStreamingThinking(
            prev.map((m) =>
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
            turnStartedAtRef.current
          )
          messagesRef.current = next
          persistSessionRef.current(sessionId, next, historyRef.current)
          return next
        })
      }
    })
    return () => {
      if (buf.raf != null) {
        window.cancelAnimationFrame(buf.raf)
        buf.raf = null
      }
      unsub()
    }
  }, [])

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const activeSessionReadOnly = (activeSession?.origin ?? 'desktop') === 'telegram'
  const activeSessionQueueStatus = activeSessionId
    ? sessionQueueStatus(activeSessionId, queueState)
    : 'idle'

  const handleSend = async (payload: {
    content: string
    images?: string[]
    attachmentLabels?: string[]
    invokedSkill?: string
  }): Promise<void> => {
    if (!selectedModel) return
    if (activeSessionReadOnly) return
    if (!payload.content.trim() && !payload.images?.length) return
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    if (sessionQueueStatus(sessionId, queueStateRef.current) !== 'idle') return

    const willQueue = queueStateRef.current.running !== null
    const turnId = uid()

    const userMsg: ChatMessage = {
      role: 'user',
      content: payload.content,
      images: payload.images
    }
    const nextHistory = [...historyRef.current, userMsg]
    historyRef.current = nextHistory

    const promptOnly = payload.content.split(/\n\nAttached file:/)[0]?.trim() ?? ''
    const uiContent =
      promptOnly && !promptOnly.startsWith('Attached file:')
        ? promptOnly
        : payload.attachmentLabels?.length
          ? payload.content.startsWith('Please review the attached')
            ? payload.content
            : `Sent ${payload.attachmentLabels.length} file(s)`
          : payload.content

    const nextMessages: UiMessage[] = [
      ...messagesRef.current,
      {
        kind: 'user',
        id: uid(),
        content: uiContent,
        createdAt: nowIso(),
        attachmentLabels: payload.attachmentLabels,
        model: selectedModel,
        ...(willQueue ? { queueStatus: 'queued' as const } : {})
      }
    ]
    syncMessages(nextMessages)

    let title = sessionTitleRef.current
    if (title === 'New chat') {
      title = titleFromPrompt(uiContent)
      sessionTitleRef.current = title
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId ? { ...session, title } : session
        )
      )
      pendingAiTitleRef.current = {
        sessionId,
        prompt: uiContent,
        turnId
      }
    }
    persistSession(sessionId, nextMessages, nextHistory, title)

    if (!willQueue) {
      activeTurnIdRef.current = turnId
      turnStartedAtRef.current = Date.now()
      turnModelRef.current = selectedModel
      setBusy(true)
      setActivity({
        phase: 'thinking',
        detail: 'Waiting for the model…',
        thinking: '',
        startedAt: Date.now()
      })
    }

    const result = await window.api.chat.send({
      model: selectedModel,
      messages: nextHistory,
      sessionId,
      turnId,
      contextUsed: contextUsage?.used,
      invokedSkill: payload.invokedSkill
    })
    if (!result.ok) {
      const reverted = nextMessages.slice(0, -1)
      historyRef.current = historyRef.current.slice(0, -1)
      syncMessages(reverted)
      persistSession(sessionId, reverted, historyRef.current, title)
      return
    }
  }

  const handleAbort = async (): Promise<void> => {
    bumpChatEpoch()
    activeTurnIdRef.current = null
    await window.api.chat.abort()
    setBusy(false)
    setActivity(IDLE_ACTIVITY)
  }

  const handleClear = (): void => {
    if (activeSessionReadOnly) return
    const sessionId = activeSessionIdRef.current
    if (sessionId) void window.api.queue.removeSession(sessionId)
    bumpChatEpoch()
    activeTurnIdRef.current = null
    cancelAiTitle()
    historyRef.current = []
    syncMessages([])
    setBusy(false)
    setActivity(IDLE_ACTIVITY)
    sessionTitleRef.current = 'New chat'
    setContextUsage(null)
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId ? { ...session, title: 'New chat' } : session
      )
    )
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    if (sessionId) void writeSession(sessionId, [], [], 'New chat')
  }

  const leaveCurrentSession = useCallback(async (): Promise<void> => {
    const sessionId = activeSessionIdRef.current
    if (sessionId && activeTurnIdRef.current) {
      backgroundSessionsRef.current.set(
        sessionId,
        createBackgroundSessionTurn(
          messagesRef.current,
          historyRef.current,
          turnModelRef.current
        )
      )
    }
    bumpChatEpoch()
    activeTurnIdRef.current = null
    setBusy(false)
    setActivity(IDLE_ACTIVITY)
    setContextUsage(null)
    await flushActiveSession()
  }, [bumpChatEpoch, flushActiveSession])

  const handleNewSession = async (): Promise<void> => {
    setView('chat')
    await leaveCurrentSession()
    const state = await window.api.sessions.create()
    applySessionsState(state)
  }

  const handleSelectSession = async (id: string): Promise<void> => {
    setView('chat')
    if (id === activeSessionIdRef.current) return
    await leaveCurrentSession()
    const state = await window.api.sessions.setActive(id)
    const bg = backgroundSessionsRef.current.get(id)
    if (bg) {
      backgroundSessionsRef.current.delete(id)
      setSessions(state.sessions)
      setActiveSessionId(id)
      activeSessionIdRef.current = id
      messagesRef.current = bg.messages
      setMessages(bg.messages)
      historyRef.current = bg.history
      const session = state.sessions.find((s) => s.id === id)
      sessionTitleRef.current = session?.title ?? 'New chat'
    } else {
      applySessionsState(state)
    }
    const running = queueStateRef.current.running
    if (running?.sessionId === id) {
      adoptRunningTurn(id, running.turnId)
    }
  }

  const handleDeleteSession = async (id: string): Promise<void> => {
    const target = sessions.find((s) => s.id === id)
    if (!target) return
    if (pendingAiTitleRef.current?.sessionId === id) {
      cancelAiTitle()
    }
    if (id === activeSessionIdRef.current) {
      await leaveCurrentSession()
    }
    const state = await window.api.sessions.delete(id)
    applySessionsState(state)
  }

  const handleSelectModel = async (model: string): Promise<void> => {
    setSelectedModel(model)
    setContextUsage(null)
    await window.api.setSelectedModelForProvider(llmProvider, model)
    if (llmProvider === 'openai') {
      setSelectedOpenAiModel(model)
    }
  }

  const handleUseModelInChat = async (model: string): Promise<void> => {
    await handleSelectModel(model)
    setView('chat')
  }

  const handleSetBaseUrl = async (url: string): Promise<void> => {
    const saved = await window.api.ollama.setBaseUrl(url)
    setBaseUrl(saved)
    await refreshOllama()
  }

  const handleSetShowThinking = async (enabled: boolean): Promise<void> => {
    setShowThinking(enabled)
    showThinkingRef.current = enabled
    await window.api.setShowThinking(enabled)
  }

  const handleSetMaxToolIterations = async (value: number): Promise<void> => {
    const saved = await window.api.setMaxToolIterations(value)
    setMaxToolIterations(saved)
  }

  const handleSetDefaultImageModel = async (model: string | null): Promise<void> => {
    const saved = await window.api.setDefaultImageModel(model)
    setDefaultImageModel(saved)
  }

  const handleSetTelegramToken = async (token: string | null): Promise<void> => {
    const status = await window.api.telegram.setToken(token)
    setTelegramStatus(status)
    setTelegramTokenDraft('')
  }

  const handleSetTelegramEnabled = async (enabled: boolean): Promise<void> => {
    setTelegramEnabled(enabled)
    const status = await window.api.telegram.setEnabled(enabled)
    setTelegramStatus(status)
  }

  const handleSetTelegramAllowedUserIds = async (ids: number[]): Promise<void> => {
    const saved = await window.api.telegram.setAllowedUserIds(ids)
    setTelegramAllowedUserIds(saved)
  }

  const handleSetLlmProvider = async (provider: LlmProvider): Promise<void> => {
    await window.api.setLlmProvider(provider)
    setLlmProvider(provider)
    const config = await window.api.getConfig()
    setSelectedModel(config.selectedModel)
    await refreshModelsForProvider(provider)
  }

  const handleSetOpenaiEnabled = async (enabled: boolean): Promise<void> => {
    await window.api.setOpenaiEnabled(enabled)
    setOpenaiEnabled(enabled)
    await refreshOpenAiStatus()
  }

  const handleSetOpenaiApiKey = async (key: string | null): Promise<void> => {
    await window.api.setOpenaiApiKey(key)
    setOpenaiApiKeyDraft(key ?? '')
    await refreshOpenAiStatus()
  }

  const handleValidateOpenai = async (): Promise<void> => {
    const config = await window.api.openai.validateAndFetchModels()
    await applyConfig(config)
  }

  const handleRefreshOpenAi = async (): Promise<void> => {
    const config = await window.api.openai.refreshModels()
    await applyConfig(config)
  }

  const handleToggleOpenAiModel = async (id: string, enabled: boolean): Promise<void> => {
    await window.api.setOpenaiModelEnabled(id, enabled)
    setOpenaiModelEnabled((prev) => ({ ...prev, [id]: enabled }))
    await refreshOpenAiStatus()
    if (llmProvider === 'openai') {
      await refreshModelsForProvider('openai')
    }
  }

  const openAiChatReady =
    openaiStatus.validationOk && openaiStatus.enabledCount > 0
  const canSendBackend =
    llmProvider === 'openai' ? openAiChatReady || ollamaOk : ollamaOk
  const imageModelNames = [
    ...new Set([
      ...models
        .filter(
          (m) =>
            m.tags?.some((t) => t.toLowerCase() === 'image') ||
            m.capabilities?.some((c) => c.toLowerCase() === 'image') ||
            /z-image|flux|sdxl|stable-diffusion|stable_diffusion|imagen|dreamshaper|animagine/i.test(
              m.name
            )
        )
        .map((m) => m.name),
      ...openaiCatalog
        .filter((m) => openaiModelEnabled[m.id] && isOpenAiImageGenModel(m.id))
        .map((m) => m.id)
    ])
  ]

  const handleNavigate = (
    target: 'chat' | 'models' | 'mcp' | 'skills' | 'schedules' | 'settings'
  ): void => {
    if (target === 'models') {
      setModelsVisited(true)
      void window.api.ollama.searchLibrary({ page: 1 }).catch(() => {})
    } else if (target === 'mcp') {
      setMcpVisited(true)
    } else if (target === 'skills') {
      setSkillsVisited(true)
    } else if (target === 'schedules') {
      setSchedulesVisited(true)
    } else if (target === 'settings') {
      setSettingsVisited(true)
    }
    setView(target)
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-[#0f1419] text-[#e7ecf1]">
      {scheduleToast && (
        <div
          className="absolute left-1/2 top-3 z-50 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-[#2d6cb5]/40 bg-[#1a3050] px-4 py-3 shadow-lg shadow-black/40"
          role="status"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[#9ec5f0]">
                Schedule: {scheduleToast.scheduleName}
              </p>
              <p className="mt-1 text-sm text-[#c5d0dc]">{scheduleToast.snippet}</p>
            </div>
            <button
              type="button"
              onClick={() => setScheduleToast(null)}
              className="shrink-0 text-xs text-[#8b9aab] hover:text-[#e7ecf1]"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        queueState={queueState}
        view={view}
        onNewSession={() => void handleNewSession()}
        onSelectSession={(id) => void handleSelectSession(id)}
        onDeleteSession={(id) => void handleDeleteSession(id)}
        onNavigate={handleNavigate}
      />
      {modelsVisited ? (
        <div
          className={
            view === 'models' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'
          }
        >
          <ModelsPage
            models={models}
            ollamaOk={ollamaOk}
            selectedModel={selectedModel}
            openaiEnabled={openaiEnabled}
            openaiStatus={openaiStatus}
            openaiCatalog={openaiCatalog}
            openaiModelEnabled={openaiModelEnabled}
            selectedOpenAiModel={selectedOpenAiModel}
            active={view === 'models'}
            onRefreshModels={async () => {
              await refreshOllama()
              if (llmProvider === 'ollama') {
                const config = await window.api.getConfig()
                setSelectedModel(config.selectedModel)
              }
            }}
            onRefreshOpenAi={() => handleRefreshOpenAi()}
            onToggleOpenAiModel={(id, enabled) => handleToggleOpenAiModel(id, enabled)}
            onUseInChat={(m) => void handleUseModelInChat(m)}
          />
        </div>
      ) : null}
      {mcpVisited ? (
        <div
          className={view === 'mcp' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}
        >
          <McpCatalogPage
            servers={servers}
            tools={tools}
            onRefreshServers={() => refreshServers()}
          />
        </div>
      ) : null}
      {skillsVisited ? (
        <div
          className={
            view === 'skills' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'
          }
        >
          <SkillsPage active={view === 'skills'} />
        </div>
      ) : null}
      {schedulesVisited ? (
        <div
          className={
            view === 'schedules' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'
          }
        >
          <SchedulesPage active={view === 'schedules'} sessions={sessions} />
        </div>
      ) : null}
      {settingsVisited ? (
        <div
          className={
            view === 'settings' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'
          }
        >
          <Settings
            llmProvider={llmProvider}
            openaiEnabled={openaiEnabled}
            openaiApiKeyDraft={openaiApiKeyDraft}
            openaiStatus={openaiStatus}
            ollamaOk={ollamaOk}
            ollamaError={ollamaError}
            baseUrl={baseUrl}
            showThinking={showThinking}
            maxToolIterations={maxToolIterations}
            defaultImageModel={defaultImageModel}
            imageModelNames={imageModelNames}
            imageGenSupported={imageGenSupported}
            telegramEnabled={telegramEnabled}
            telegramAllowedUserIds={telegramAllowedUserIds}
            telegramStatus={telegramStatus}
            telegramTokenDraft={telegramTokenDraft}
            onSetTelegramToken={(token) => void handleSetTelegramToken(token)}
            onSetTelegramEnabled={(enabled) => void handleSetTelegramEnabled(enabled)}
            onSetTelegramAllowedUserIds={(ids) =>
              void handleSetTelegramAllowedUserIds(ids)
            }
            onRefreshOllama={() => void refreshOllama()}
            onSetBaseUrl={(u) => void handleSetBaseUrl(u)}
            onSetShowThinking={(v) => void handleSetShowThinking(v)}
            onSetMaxToolIterations={(v) => void handleSetMaxToolIterations(v)}
            onSetLlmProvider={(p) => void handleSetLlmProvider(p)}
            onSetOpenaiEnabled={(v) => void handleSetOpenaiEnabled(v)}
            onSetOpenaiApiKey={(k) => void handleSetOpenaiApiKey(k)}
            onValidateOpenai={() => void handleValidateOpenai()}
            onOpenModelsPage={() => handleNavigate('models')}
            onSetDefaultImageModel={(model) => void handleSetDefaultImageModel(model)}
          />
        </div>
      ) : null}
      {view === 'chat' ? (
        <Chat
          key={activeSessionId ?? 'chat'}
          title={
            sessions.find((s) => s.id === activeSessionId)?.title ?? 'New chat'
          }
          messages={messages}
          busy={busy}
          activity={activity}
          showThinking={showThinking}
          canSend={
            Boolean(selectedModel) &&
            canSendBackend &&
            !activeSessionReadOnly &&
            activeSessionQueueStatus === 'idle'
          }
          readOnly={activeSessionReadOnly}
          llmProvider={llmProvider}
          ollamaOk={ollamaOk}
          imageGenSupported={imageGenSupported}
          models={models}
          selectedModel={selectedModel}
          tools={tools}
          contextUsage={contextUsage}
          onSelectModel={(m) => void handleSelectModel(m)}
          onSend={(payload) => void handleSend(payload)}
          onAbort={() => void handleAbort()}
          onClear={handleClear}
          onOpenSettings={() => handleNavigate('settings')}
        />
      ) : null}
    </div>
  )
}
