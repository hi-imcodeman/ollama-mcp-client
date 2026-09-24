import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSkill, LlmProvider, McpToolInfo, OllamaModel, UiMessage } from '../../../shared/types'
import type { ActivityState } from './ActivityIndicator'
import { DownloadImageButton } from './DownloadImageButton'
import { ActivityIndicator } from './ActivityIndicator'
import { AssistantReplyTimer } from './AssistantReplyTimer'
import { CopyButton } from './CopyButton'
import { ImageLightbox } from './ImageLightbox'
import { MarkdownContent } from './MarkdownContent'
import { MessageMeta } from './MessageMeta'
import { SkillSlashMenu, SLASH_PREVIEW_COUNT } from './SkillSlashMenu'
import { ThinkingCard } from './ThinkingCard'
import { ToolCallCard } from './ToolCallCard'
import {
  type ChatAttachment,
  buildMessageFromAttachments,
  fileToAttachment,
  formatBytes
} from '../lib/attachments'
import {
  filterSkills,
  parseInvokedSkill,
  slashQuery
} from '../lib/slashSkills'
import {
  type ContextSlice,
  buildContextSlices,
  buildSkillsContextText,
  contextUsageColor,
  estimateDraftTokens,
  estimateLivePromptTokens,
  formatTokenCount
} from '../lib/contextUsage'

interface ChatProps {
  title: string
  messages: UiMessage[]
  busy: boolean
  activity: ActivityState
  showThinking: boolean
  canSend: boolean
  readOnly?: boolean
  llmProvider: LlmProvider
  ollamaOk: boolean
  imageGenSupported?: boolean
  models: OllamaModel[]
  selectedModel: string | null
  tools: McpToolInfo[]
  contextUsage: { used: number; limit: number } | null
  onSelectModel: (model: string) => void
  onSend: (payload: {
    content: string
    images?: string[]
    attachmentLabels?: string[]
    invokedSkill?: string
  }) => void
  onAbort: () => void
  onClear: () => void
  onOpenSettings: () => void
}

export function Chat({
  title,
  messages,
  busy,
  activity,
  showThinking,
  canSend,
  readOnly = false,
  llmProvider,
  ollamaOk,
  imageGenSupported = true,
  models,
  selectedModel,
  tools,
  contextUsage,
  onSelectModel,
  onSend,
  onAbort,
  onClear,
  onOpenSettings
}: ChatProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [slashSkills, setSlashSkills] = useState<AgentSkill[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashExpanded, setSlashExpanded] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [modelLimit, setModelLimit] = useState<number | null>(null)
  const [modelSystem, setModelSystem] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const programmaticScrollRef = useRef(false)
  const scrollTimeoutRef = useRef<number | null>(null)
  const [animateEnter, setAnimateEnter] = useState(false)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const clearProgrammaticScroll = (): void => {
    programmaticScrollRef.current = false
    if (scrollTimeoutRef.current != null) {
      window.clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
  }

  /** User scrolled away — stop auto-follow so streaming does not yank them back. */
  const releaseStickToBottom = (): void => {
    stickToBottomRef.current = false
    clearProgrammaticScroll()
  }

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth'): void => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    programmaticScrollRef.current = true
    if (scrollTimeoutRef.current != null) {
      window.clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    const pin = (): void => {
      const node = scrollRef.current
      if (!node || !stickToBottomRef.current) return
      node.scrollTop = node.scrollHeight
    }
    if (behavior === 'auto') {
      pin()
      requestAnimationFrame(() => {
        pin()
        requestAnimationFrame(() => {
          pin()
          programmaticScrollRef.current = false
        })
      })
      return
    }
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' })
    scrollTimeoutRef.current = window.setTimeout(() => {
      scrollTimeoutRef.current = null
      pin()
      programmaticScrollRef.current = false
    }, 320)
  }

  const canCompose = canSend && !busy && !readOnly
  const hasDraft = Boolean(draft.trim()) || attachments.length > 0
  const slashToken = slashQuery(draft)
  const slashMatches = useMemo(
    () =>
      slashToken == null ? [] : filterSkills(slashSkills, slashToken),
    [slashSkills, slashToken]
  )
  const slashOpen =
    slashToken != null &&
    !slashDismissed &&
    slashSkills.length > 0 &&
    slashMatches.length > 0
  const slashVisible = slashExpanded
    ? slashMatches
    : slashMatches.slice(0, SLASH_PREVIEW_COUNT)
  const selectedMeta = models.find((m) => m.name === selectedModel)
  const modelHasVision = Boolean(
    selectedMeta?.tags?.some((t) => t.toLowerCase() === 'vision') ||
      selectedMeta?.capabilities?.some((c) => c.toLowerCase() === 'vision') ||
      /vision|llava|bakllava|moondream|minicpm-v|qwen2(\.5)?-?vl|gemma3|pixtral/i.test(
        selectedModel ?? ''
      )
  )
  const modelIsImageGen = Boolean(
    selectedMeta?.tags?.some((t) => t.toLowerCase() === 'image') ||
      selectedMeta?.capabilities?.some((c) => c.toLowerCase() === 'image') ||
      /z-image|flux|sdxl|stable-diffusion|stable_diffusion|imagen|dreamshaper|animagine/i.test(
        selectedModel ?? ''
      )
  )
  const hasStreamingAssistant = messages.some(
    (m) => m.kind === 'assistant' && m.streaming
  )
  const hasRunningTool = messages.some(
    (m) => m.kind === 'tool' && m.status === 'running'
  )
  /** Hide activity once transcript cards own the phase (reply text, tool call). */
  const showActivity =
    busy &&
    !(activity.phase === 'generating' && hasStreamingAssistant) &&
    !(activity.phase === 'tool' && hasRunningTool)
  const hasImageAttachment = attachments.some((a) => a.kind === 'image')
  const modelNames = models.map((m) => m.name)

  const sessionImages = useMemo(() => {
    const list: string[] = []
    for (const m of messages) {
      if (m.kind === 'assistant' && m.images?.length) {
        list.push(...m.images)
      }
    }
    return list
  }, [messages])

  useEffect(() => {
    if (lightboxIndex == null) return
    if (sessionImages.length === 0) {
      setLightboxIndex(null)
      return
    }
    if (lightboxIndex >= sessionImages.length) {
      setLightboxIndex(sessionImages.length - 1)
    }
  }, [lightboxIndex, sessionImages])

  const openLightbox = (src: string): void => {
    const idx = sessionImages.indexOf(src)
    setLightboxIndex(idx >= 0 ? idx : 0)
  }

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return
    const streaming =
      busy ||
      messages.some(
        (m) =>
          (m.kind === 'assistant' || m.kind === 'thinking') &&
          Boolean(m.streaming)
      )
    const behavior: ScrollBehavior =
      !animateEnter ||
      streaming ||
      (showActivity && activity.phase === 'generating')
        ? 'auto'
        : 'smooth'
    scrollToBottom(behavior)
  }, [
    messages,
    activity.phase,
    activity.detail,
    activity.thinking,
    showActivity,
    busy,
    animateEnter
  ])

  useEffect(() => {
    setAnimateEnter(true)
  }, [])

  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return
      const node = scrollRef.current
      if (!node) return
      programmaticScrollRef.current = true
      node.scrollTop = node.scrollHeight
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  const onMessagesScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distanceFromBottom < 80
    if (programmaticScrollRef.current) return
    stickToBottomRef.current = nearBottom
  }

  const onMessagesWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    // deltaY < 0 = user scrolling toward earlier messages. Detach before
    // scrollTop updates, otherwise the next stream chunk re-pins instantly.
    if (e.deltaY < 0) releaseStickToBottom()
  }

  const onMessagesTouchMove = (): void => {
    // Finger drag: release; onScroll re-sticks if they are still at the bottom.
    releaseStickToBottom()
  }

  const onMessagesKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (
      e.key === 'PageUp' ||
      e.key === 'Home' ||
      e.key === 'ArrowUp' ||
      (e.key === ' ' && e.shiftKey)
    ) {
      releaseStickToBottom()
    }
  }

  useEffect(() => {
    if (!modelOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (!modelMenuRef.current?.contains(e.target as Node)) {
        setModelOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [modelOpen])

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.api.skills.list().then((list) => {
        if (!cancelled) setSlashSkills(list.filter((s) => s.enabled))
      })
    }
    load()
    const onFocus = (): void => load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [slashToken])

  useEffect(() => {
    setSlashIndex(0)
    setSlashExpanded(false)
    setSlashDismissed(false)
  }, [slashToken])

  useEffect(() => {
    if (!selectedModel) {
      setModelLimit(null)
      setModelSystem('')
      return
    }
    if (llmProvider === 'openai') {
      setModelLimit(128_000)
      setModelSystem('')
      return
    }
    if (!ollamaOk) {
      setModelLimit(null)
      setModelSystem('')
      return
    }
    let cancelled = false
    setModelLimit(null)
    setModelSystem('')
    void window.api.ollama
      .showModel(selectedModel)
      .then((detail) => {
        if (cancelled) return
        const next = detail.contextLength
        if (next && next > 0) setModelLimit(next)
        setModelSystem(detail.system?.trim() ?? '')
      })
      .catch(() => {
        // Keep null / last successful value from a later resolve; don't blank on errors.
      })
    return () => {
      cancelled = true
    }
  }, [selectedModel, ollamaOk, llmProvider])

  const backendReady = llmProvider === 'openai' ? canSend || ollamaOk : ollamaOk

  const contextLimit =
    (contextUsage && contextUsage.limit > 0 ? contextUsage.limit : null) ??
    modelLimit

  const recentlyCompacted = useMemo(() => {
    let userIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === 'user') {
        userIdx = i
        break
      }
    }
    return (
      userIdx >= 0 &&
      messages.some((m, i) => m.kind === 'notice' && i >= Math.max(0, userIdx - 1))
    )
  }, [messages])

  const lastReplyContext = useMemo(() => {
    const last = messages[messages.length - 1]
    if (last?.kind !== 'assistant' || last.streaming) return undefined
    if (last.contextUsed == null || last.contextUsed <= 0) return undefined
    let userIdx = -1
    for (let i = messages.length - 2; i >= 0; i--) {
      if (messages[i].kind === 'user') {
        userIdx = i
        break
      }
    }
    // Post-turn compact inserts a notice before this user; don't floor to the
    // pre-compact snapshot.
    if (
      userIdx >= 0 &&
      messages.some((m, i) => m.kind === 'notice' && i >= Math.max(0, userIdx - 1))
    ) {
      return undefined
    }
    return last.contextUsed
  }, [messages])

  const skillsText = useMemo(
    () => buildSkillsContextText(slashSkills),
    [slashSkills]
  )

  const contextUsed = useMemo(() => {
    const live = estimateLivePromptTokens({
      systemPrompt: modelSystem,
      skills: slashSkills,
      tools,
      messages,
      draft,
      attachments
    })
    // During an active turn, Ollama's prompt counts are a better floor than char/4.
    const draftTokens = estimateDraftTokens(draft, attachments)
    const reported =
      contextUsage && contextUsage.used > 0 ? contextUsage.used : 0
    const measured = Math.max(reported, lastReplyContext ?? 0)
    if (busy && measured > 0) {
      return Math.max(live, measured + draftTokens)
    }
    // Idle meter: reflect the next prompt (skills/MCP toggles must update immediately).
    return live
  }, [
    attachments,
    busy,
    contextUsage,
    draft,
    lastReplyContext,
    messages,
    modelSystem,
    slashSkills,
    tools
  ])

  const contextSlices = useMemo(
    () =>
      buildContextSlices({
        used: contextUsed,
        systemPrompt: modelSystem,
        skillsText,
        tools,
        messages,
        draft,
        attachments
      }),
    [attachments, contextUsed, draft, messages, modelSystem, skillsText, tools]
  )

  const applySlashSkill = (skill: AgentSkill): void => {
    setDraft(`/${skill.name} `)
    setSlashDismissed(true)
  }

  const submit = (e?: React.FormEvent): void => {
    e?.preventDefault()
    if (!hasDraft || !canCompose) return
    if (modelIsImageGen) {
      const prompt = draft.trim()
      if (!prompt) return
      stickToBottomRef.current = true
      onSend({ content: prompt })
      setDraft('')
      setAttachments([])
      setAttachError(null)
      return
    }
    const built = buildMessageFromAttachments(draft, attachments)
    if (!built.content && !built.images?.length) return
    const invoked = parseInvokedSkill(built.content, slashSkills)
    stickToBottomRef.current = true
    onSend({
      content: built.content,
      images: built.images,
      attachmentLabels: built.labels,
      invokedSkill: invoked.skillName
    })
    setDraft('')
    setAttachments([])
    setAttachError(null)
  }

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return
    setAttachError(null)
    const next: ChatAttachment[] = []
    const errors: string[] = []
    for (const file of Array.from(files)) {
      try {
        next.push(await fileToAttachment(file))
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
    if (next.length) {
      setAttachments((prev) => [...prev, ...next])
    }
    if (errors.length) {
      setAttachError(errors.join(' · '))
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeAttachment = (id: string): void => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="titlebar-drag titlebar-overlay-pad flex items-center justify-between border-b border-[#243041] px-5 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-[#f0f4f8]">
            <span className="truncate">{title || 'Chat'}</span>
            {busy && (
              <span className="header-live inline-flex items-center gap-1.5 rounded-full border border-[#2a3a4d] bg-[#161d27] px-2 py-0.5 text-[10px] font-normal uppercase tracking-wider text-[#8b9aab]">
                <span className="header-live-dot h-1.5 w-1.5 rounded-full bg-[var(--activity-accent,#6eb5ff)]" />
                Live
              </span>
            )}
          </div>
          <div
            className={`flex items-center gap-1.5 text-xs ${
              backendReady ? 'text-emerald-400/90' : 'text-rose-300/90'
            }`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                backendReady ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
              aria-hidden
            />
            {llmProvider === 'openai'
              ? backendReady
                ? 'OpenAI ready'
                : 'OpenAI unavailable'
              : ollamaOk
                ? 'Connected'
                : 'Disconnected'}
          </div>
        </div>
        <div className="titlebar-no-drag flex gap-2">
          {busy && (
            <button
              type="button"
              onClick={onAbort}
              className="rounded border border-[#4a3030] px-3 py-1 text-xs text-rose-300 hover:bg-[#2a1818]"
            >
              Stop
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={onClear}
              className="rounded border border-[#2a3a4d] px-3 py-1 text-xs text-[#c5d0dc] hover:bg-[#1a2430]"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            title="Settings"
            className="flex items-center justify-center rounded border border-[#2a3a4d] px-2 py-1 text-[#c5d0dc] hover:bg-[#1a2430]"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M6.5 2.5h3l.4 1.4a4.5 4.5 0 0 1 1.1.6l1.4-.5.1.2 1.5 2.6-.9 1.1c.1.4.1.7 0 1.1l.9 1.1-1.5 2.6-.1.2-1.4-.5a4.5 4.5 0 0 1-1.1.6L9.5 13.5h-3l-.4-1.4a4.5 4.5 0 0 1-1.1-.6l-1.4.5-.1-.2L1.9 9.2l.9-1.1a4.2 4.2 0 0 1 0-1.1l-.9-1.1L3.5 3.2l.1-.2 1.4.5c.3-.3.7-.5 1.1-.6L6.5 2.5Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={onMessagesScroll}
        onWheel={onMessagesWheel}
        onTouchMove={onMessagesTouchMove}
        onKeyDown={onMessagesKeyDown}
        tabIndex={-1}
        className="flex-1 overflow-y-auto px-5 py-4 outline-none"
      >
        <div
          ref={contentRef}
          className="chat-transcript space-y-3"
          data-animate-enter={animateEnter ? '' : undefined}
        >
        {messages.length === 0 && !busy && (
          <div className="mx-auto mt-16 max-w-md text-center text-sm text-[#6b7a8c]">
            <p className="mb-2 text-[#8b9aab]">Ready when you are.</p>
            <p>
              Connect Ollama, pick a tool-capable model, add an MCP server, then
              ask the model to use its tools. Use + to attach images or text
              files.
            </p>
          </div>
        )}
        {messages.map((m) => {
          if (m.kind === 'user') {
            return (
              <div key={m.id} className="msg-enter flex justify-end">
                <div className="max-w-[80%]">
                  <div className="rounded-2xl rounded-br-md bg-[#1e3a5f] px-3.5 py-2 text-sm leading-relaxed text-[#e7ecf1]">
                    {m.attachmentLabels && m.attachmentLabels.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-1">
                        {m.attachmentLabels.map((label) => (
                          <span
                            key={label}
                            className="rounded-full bg-[#152842] px-2 py-0.5 text-[11px] text-[#9ec5f0]"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  </div>
                  {m.queueStatus === 'queued' && (
                    <p className="mt-1 text-right text-[11px] text-amber-300/90">
                      Waiting in queue…
                    </p>
                  )}
                  <MessageMeta createdAt={m.createdAt} model={m.model} align="right" />
                </div>
              </div>
            )
          }
          if (m.kind === 'assistant') {
            const showReplyTimer =
              Boolean(m.streaming && m.startedAt) || m.durationMs != null
            return (
              <div key={m.id} className="msg-enter group/assistant flex justify-start">
                <div className="max-w-[85%]">
                  <div
                    className={`relative rounded-2xl rounded-bl-md border border-[#2a3a4d] bg-[#161d27] px-3.5 py-2 text-sm leading-relaxed text-[#e7ecf1] ${
                      showReplyTimer ? 'pt-6' : ''
                    }`}
                  >
                    <AssistantReplyTimer
                      active={Boolean(m.streaming)}
                      startedAt={m.startedAt}
                      durationMs={m.durationMs}
                    />
                    {m.images && m.images.length > 0 && (
                      <div className="flex flex-col gap-2">
                        {m.images.map((src, i) => (
                          <div
                            key={`${m.id}-img-${i}`}
                            className="relative w-full max-w-[min(100%,28rem)]"
                          >
                            <img
                              src={src}
                              alt="Generated image"
                              className="aspect-square max-h-[28rem] w-full cursor-zoom-in rounded-lg object-contain"
                              onClick={() => openLightbox(src)}
                            />
                            <div
                              className="mt-1.5 flex justify-end opacity-80 transition group-hover/assistant:opacity-100"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <DownloadImageButton src={src} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {(m.content.trim() || m.streaming) && (
                      <MarkdownContent content={m.content} streaming={m.streaming} />
                    )}
                    {!m.streaming && m.content.trim() ? (
                      <div className="mt-2 flex justify-end opacity-70 transition group-hover/assistant:opacity-100">
                        <CopyButton text={m.content} />
                      </div>
                    ) : null}
                  </div>
                  <MessageMeta
                    createdAt={m.createdAt}
                    liveTotal={m.streaming}
                    totalStartedAt={m.streaming ? activity.startedAt : undefined}
                    responseMs={m.responseMs}
                    tokensPerSec={m.streaming ? undefined : m.tokensPerSec}
                    model={m.model}
                    contextUsed={m.streaming ? undefined : m.contextUsed}
                    contextLimit={m.streaming ? undefined : m.contextLimit}
                    tokenUsage={m.streaming ? undefined : m.tokenUsage}
                    multiCallTurn={m.streaming ? undefined : m.multiCallTurn}
                    align="left"
                  />
                </div>
              </div>
            )
          }
          if (m.kind === 'thinking') {
            if (!showThinking) return null
            return (
              <ThinkingCard
                key={m.id}
                content={m.content}
                streaming={m.streaming}
                createdAt={m.createdAt}
                model={m.model}
                startedAt={m.startedAt}
                durationMs={m.durationMs}
                elapsedMs={m.elapsedMs}
              />
            )
          }
          if (m.kind === 'tool') {
            return (
              <ToolCallCard
                key={m.id}
                name={m.name}
                arguments={m.arguments}
                status={m.status}
                result={m.result}
                createdAt={m.createdAt}
                model={m.model}
                startedAt={m.startedAt}
                durationMs={m.durationMs}
                elapsedMs={m.elapsedMs}
              />
            )
          }
          if (m.kind === 'notice') {
            return (
              <div
                key={m.id}
                className="msg-enter flex items-center gap-3 py-3"
                title="Earlier messages were compacted so the model history would fit the context window"
              >
                <span className="h-px min-w-4 flex-1 bg-[#3d5168]" aria-hidden />
                <div className="inline-flex max-w-[min(100%,24rem)] items-center gap-2 rounded-full border border-[#fb7185]/35 bg-[#fb7185]/10 px-3 py-1.5 text-[12px] leading-snug text-[#f5c4ce]">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#fb7185]" aria-hidden />
                  <span>{m.content}</span>
                </div>
                <span className="h-px min-w-4 flex-1 bg-[#3d5168]" aria-hidden />
              </div>
            )
          }
          return (
            <div key={m.id} className="msg-enter max-w-[85%]">
              <div className="rounded border border-rose-900/40 bg-rose-950/30 px-3 py-2 text-sm text-rose-200">
                {m.content}
              </div>
              <MessageMeta createdAt={m.createdAt} model={m.model} align="left" />
            </div>
          )
        })}

        <ActivityIndicator
          activity={activity}
          visible={showActivity}
          showThinking={showThinking}
        />
        <div ref={bottomRef} />
        </div>
      </div>

      <form onSubmit={submit} className="px-5 pb-5 pt-2">
        {readOnly && (
          <p className="mb-2 rounded-lg border border-[#2d4a6a]/50 bg-[#1a3050]/40 px-3 py-2 text-xs text-[#9ec5f0]">
            Telegram session — view only on desktop. Send messages from Telegram.
          </p>
        )}
        {llmProvider === 'ollama' && !ollamaOk && (
          <p className="mb-2 text-xs text-amber-300/90">
            Ollama is offline — check Settings or switch to OpenAI.
          </p>
        )}
        {llmProvider === 'openai' && !canSend && !readOnly && (
          <p className="mb-2 text-xs text-amber-300/90">
            Select an enabled OpenAI model, or validate your API key in Settings.
          </p>
        )}
        {attachError && (
          <p className="mb-2 text-xs text-rose-300">{attachError}</p>
        )}
        {modelIsImageGen && (
          <p className="mb-2 text-xs text-[#8b9aab]">
            Image model selected — your message will be used as a generation prompt.
          </p>
        )}
        {modelIsImageGen && !imageGenSupported && (
          <p className="mb-2 text-xs text-amber-300/90">
            Your Ollama build does not support image generation (removed in v0.32.6+).
            Use Ollama 0.32.5 for models like x/z-image-turbo, or wait for a release that
            restores it.
          </p>
        )}
        {hasImageAttachment && selectedModel && !modelHasVision && !modelIsImageGen && (
          <p className="mb-2 text-xs text-amber-300/90">
            "{selectedModel}" may not support images. Pick a model tagged{' '}
            <span className="font-medium">vision</span>, or the model will ignore
            the attachment.
          </p>
        )}
        {hasImageAttachment && selectedMeta?.family === 'mllama' && (
          <p className="mb-2 text-xs text-amber-300/90">
            This model uses architecture <span className="font-medium">mllama</span>.
            If chat fails to load it, update Ollama or switch to llava / moondream /
            gemma3.
          </p>
        )}
        <div className="composer-shell relative rounded-[28px] border border-[#2a3a4d] bg-[#1a1f26] px-4 pb-3 pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus-within:border-[#3d5168]">
          {slashOpen ? (
            <SkillSlashMenu
              skills={slashMatches}
              activeIndex={slashIndex}
              expanded={slashExpanded}
              onHover={setSlashIndex}
              onSelect={applySlashSkill}
              onShowMore={() => setSlashExpanded(true)}
            />
          ) : null}
          {!modelIsImageGen && attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((file) => (
                <div
                  key={file.id}
                  className="flex max-w-full items-center gap-2 rounded-xl border border-[#2a3a4d] bg-[#121820] px-2 py-1.5"
                >
                  {file.previewUrl ? (
                    <img
                      src={file.previewUrl}
                      alt={file.name}
                      className="h-8 w-8 rounded object-cover"
                    />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded bg-[#2a313a] text-[10px] uppercase text-[#8b9aab]">
                      txt
                    </span>
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs text-[#e7ecf1]">{file.name}</div>
                    <div className="text-[10px] text-[#6b7a8c]">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAttachment(file.id)}
                    className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[#8b9aab] hover:bg-[#2a313a] hover:text-[#e7ecf1]"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (slashOpen && slashVisible.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSlashIndex((i) => (i + 1) % slashVisible.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashIndex(
                    (i) => (i - 1 + slashVisible.length) % slashVisible.length
                  )
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSlashDismissed(true)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  const skill = slashVisible[slashIndex]
                  if (skill) {
                    e.preventDefault()
                    applySlashSkill(skill)
                    return
                  }
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            onPaste={(e) => {
              if (modelIsImageGen) return
              const items = e.clipboardData?.files
              if (items && items.length > 0) {
                e.preventDefault()
                void addFiles(items)
              }
            }}
            rows={2}
            placeholder={
              busy
                ? 'Waiting for the model to finish…'
                : modelIsImageGen
                  ? 'Describe the image to generate…'
                  : slashSkills.length > 0
                    ? 'Send a message, or / for skills'
                    : 'Send a message'
            }
            disabled={!canCompose}
            className="max-h-40 min-h-[56px] w-full resize-none bg-transparent px-1 pb-12 pt-1 text-[15px] leading-relaxed text-[#e7ecf1] outline-none placeholder:text-[#6b7a8c] disabled:opacity-50"
          />

          {!modelIsImageGen && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.ts,.tsx,.js,.jsx,.py,.css,.html,.yml,.yaml,.toml,.csv,.log,.sh,.sql,.go,.rs,.java,.c,.cpp,.h"
            className="hidden"
            onChange={(e) => void addFiles(e.target.files)}
          />
          )}

          {(ollamaOk || llmProvider === 'openai') &&
          selectedModel &&
          contextLimit &&
          contextLimit > 0 ? (
            <ContextMeter
              used={contextUsed}
              limit={contextLimit}
              slices={contextSlices}
              compacted={recentlyCompacted}
            />
          ) : null}

          <div className="absolute bottom-2.5 right-2.5 flex items-center gap-2">
            {!modelIsImageGen && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!canCompose}
                title="Add file"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[#2a313a] text-[#c5d0dc] transition hover:bg-[#343c48] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M8 3.5v9M3.5 8h9"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}

            <div className="relative" ref={modelMenuRef}>
              <button
                type="button"
                disabled={modelNames.length === 0}
                onClick={() => setModelOpen((o) => !o)}
                title="Select model"
                className="flex max-w-[220px] items-center gap-1.5 rounded-full bg-[#3a424d] px-3.5 py-2 text-[13px] font-medium text-[#f0f4f8] transition hover:bg-[#454e5a] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="truncate">
                  {selectedModel ?? (modelNames.length ? 'Select model' : 'No models')}
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden
                  className="shrink-0 opacity-80"
                >
                  <path
                    d="M3 4.5L6 7.5L9 4.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {modelOpen && modelNames.length > 0 && (
                <div className="absolute bottom-full right-0 z-40 mb-2 max-h-64 min-w-[280px] overflow-y-auto rounded-xl border border-[#2a3a4d] bg-[#161d27] py-1 shadow-xl">
                  {models.map((m) => {
                    const PRIMARY_TAGS = new Set(['tools', 'thinking', 'vision', 'image'])
                    const primaryTags = m.tags.filter((tag) =>
                      PRIMARY_TAGS.has(tag.toLowerCase())
                    )
                    const otherTags = m.tags.filter(
                      (tag) => !PRIMARY_TAGS.has(tag.toLowerCase())
                    )
                    const tooltipParts: string[] = []
                    if (m.size > 0) tooltipParts.push(formatBytes(m.size))
                    if (otherTags.length > 0) tooltipParts.push(otherTags.join(' · '))
                    const tooltipText =
                      tooltipParts.length > 0 ? tooltipParts.join(' · ') : undefined

                    return (
                      <button
                        key={m.name}
                        type="button"
                        title={tooltipText}
                        onClick={() => {
                          onSelectModel(m.name)
                          setModelOpen(false)
                        }}
                        className={`flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-[#1f2833] ${
                          m.name === selectedModel ? 'bg-[#1a3050]' : ''
                        }`}
                      >
                        <span
                          className={`truncate text-[13px] ${
                            m.name === selectedModel
                              ? 'text-[#9ec5f0]'
                              : 'text-[#e7ecf1]'
                          }`}
                        >
                          {m.name}
                        </span>
                        {primaryTags.length > 0 && (
                          <span className="flex flex-wrap gap-1">
                            {primaryTags.map((tag) => (
                              <span
                                key={`${m.name}-${tag}`}
                                className="rounded bg-[#1a3050] px-1.5 py-0.5 text-[10px] text-[#9ec5f0]"
                              >
                                {tag}
                              </span>
                            ))}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={!canCompose}
              title={
                !canSend
                  ? 'Select a model first'
                  : busy
                    ? 'Wait for the current reply'
                    : 'Send'
              }
              className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
                canCompose && hasDraft
                  ? 'bg-[#e7ecf1] text-[#121820] hover:bg-white'
                  : canCompose
                    ? 'bg-[#2a313a] text-[#c5d0dc] hover:bg-[#343c48]'
                    : 'bg-[#2a313a] text-[#6b7a8c]'
              } disabled:cursor-not-allowed`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M8 12.5V3.5M8 3.5L4 7.5M8 3.5L12 7.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </form>

      {lightboxIndex != null && sessionImages.length > 0 && (
        <ImageLightbox
          images={sessionImages}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}
    </main>
  )
}

function SegmentedBar({
  slices,
  used,
  limit,
  heightClass
}: {
  slices: ContextSlice[]
  used: number
  limit: number
  heightClass: string
}): React.JSX.Element {
  const span = Math.max(used, limit, 1)
  return (
    <div className={`flex overflow-hidden rounded-full bg-[#2a313a] ${heightClass}`}>
      {slices.map((slice) => (
        <div
          key={slice.id}
          className="h-full min-w-px"
          style={{
            width: `${(slice.tokens / span) * 100}%`,
            backgroundColor: slice.color
          }}
          title={`${slice.label}: ${formatTokenCount(slice.tokens)}`}
        />
      ))}
    </div>
  )
}

function ContextMeter({
  used,
  limit,
  slices,
  compacted
}: {
  used: number
  limit: number
  slices: ContextSlice[]
  compacted?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const rawPct = limit > 0 ? (used / limit) * 100 : 0
  const over = rawPct > 100
  const color = contextUsageColor(over ? 100 : rawPct)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="absolute bottom-3 left-3 z-20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          compacted
            ? 'Earlier messages were summarized so this prompt would fit the window. Click for a breakdown.'
            : 'Tokens that will be sent on the next prompt vs the live window. Click for a breakdown.'
        }
        className="flex max-w-[calc(100vw-14rem)] items-center gap-2 rounded-md px-0.5 py-0.5 text-left hover:bg-[#ffffff08]"
      >
        <div className="h-1 w-14 overflow-hidden rounded-full bg-[#2a313a]">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.max(0, Math.min(100, rawPct))}%`,
              backgroundColor: color
            }}
          />
        </div>
        <span
          className="truncate font-mono text-[10px] tabular-nums"
          style={{ color }}
        >
          {formatTokenCount(used)} / {formatTokenCount(limit)}
          <span className="text-[#6b7a8c]"> ({Math.round(rawPct)}%)</span>
          {compacted ? ' · compacted' : ''}
        </span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Context usage"
          className="absolute bottom-full left-0 z-30 mb-2 w-[min(22rem,calc(100vw-2.5rem))] rounded-xl border border-[#2a3a4d] bg-[#161d27] p-3.5 shadow-xl"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="text-[13px] font-medium text-[#e7ecf1]">Context Usage</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-[#8b9aab] hover:bg-[#ffffff10] hover:text-[#e7ecf1]"
              aria-label="Close"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path
                  d="M3 3l6 6M9 3l-6 6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          <div className="mb-2 flex items-baseline justify-between gap-3 text-[12px]">
            <span style={{ color }}>
              {over ? `${Math.round(rawPct)}% Over` : `${Math.round(rawPct)}% Full`}
            </span>
            <span className="font-mono tabular-nums text-[#c5d0dc]">
              {formatTokenCount(used)} / {formatTokenCount(limit)} tokens
            </span>
          </div>
          <SegmentedBar slices={slices} used={used} limit={limit} heightClass="h-2" />
          <ul className="mt-3 space-y-1.5">
            {slices.map((slice) => (
              <li
                key={slice.id}
                className="flex items-center justify-between gap-3 text-[12px]"
              >
                <span className="flex min-w-0 items-center gap-2 text-[#c5d0dc]">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: slice.color }}
                    aria-hidden
                  />
                  <span className="truncate">{slice.label}</span>
                </span>
                <span className="font-mono tabular-nums text-[#9aa8b8]">
                  {formatTokenCount(slice.tokens)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
