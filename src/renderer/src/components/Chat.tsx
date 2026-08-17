import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { McpToolInfo, OllamaModel, UiMessage } from '../../../shared/types'
import type { ActivityState } from './ActivityIndicator'
import { DownloadImageButton } from './DownloadImageButton'
import { ActivityIndicator } from './ActivityIndicator'
import { CopyButton } from './CopyButton'
import { ImageLightbox } from './ImageLightbox'
import { MarkdownContent } from './MarkdownContent'
import { MessageMeta } from './MessageMeta'
import { ThinkingCard } from './ThinkingCard'
import { ToolCallCard } from './ToolCallCard'
import {
  type ChatAttachment,
  buildMessageFromAttachments,
  fileToAttachment,
  formatBytes
} from '../lib/attachments'
import {
  contextUsageColor,
  estimateDraftTokens,
  estimateMessageTokens,
  estimateToolSchemaTokens,
  formatTokenCount
} from '../lib/contextUsage'

interface ChatProps {
  messages: UiMessage[]
  busy: boolean
  activity: ActivityState
  showThinking: boolean
  canSend: boolean
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
  }) => void
  onAbort: () => void
  onClear: () => void
  onOpenSettings: () => void
}

export function Chat({
  messages,
  busy,
  activity,
  showThinking,
  canSend,
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
  const [modelOpen, setModelOpen] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [modelLimit, setModelLimit] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const programmaticScrollRef = useRef(false)
  const scrollTimeoutRef = useRef<number | null>(null)
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
    if (behavior === 'auto') {
      el.scrollTop = el.scrollHeight
      // Allow layout to settle (image-gen frame / markdown reflow)
      requestAnimationFrame(() => {
        if (!stickToBottomRef.current) {
          programmaticScrollRef.current = false
          return
        }
        const node = scrollRef.current
        if (node) node.scrollTop = node.scrollHeight
        programmaticScrollRef.current = false
      })
      return
    }
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' })
    scrollTimeoutRef.current = window.setTimeout(() => {
      scrollTimeoutRef.current = null
      programmaticScrollRef.current = false
      if (stickToBottomRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }, 320)
  }

  const canCompose = canSend && !busy
  const hasDraft = Boolean(draft.trim()) || attachments.length > 0
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
  /** Hide generating spinner once reply text streams; keep it for image gen. */
  const showActivity =
    busy && !(activity.phase === 'generating' && hasStreamingAssistant)
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
    // Smooth scroll fights rapid thinking/token updates and looks shaky.
    const behavior: ScrollBehavior =
      streaming || (showActivity && activity.phase === 'generating')
        ? 'auto'
        : 'smooth'
    scrollToBottom(behavior)
  }, [
    messages,
    activity.phase,
    activity.detail,
    activity.thinking,
    showActivity,
    busy
  ])

  const onMessagesScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distanceFromBottom < 80
    // While we are auto-scrolling, still honor a user override that left the bottom.
    if (programmaticScrollRef.current) {
      if (!nearBottom) releaseStickToBottom()
      return
    }
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
    if (!selectedModel || !ollamaOk) {
      setModelLimit(null)
      return
    }
    let cancelled = false
    setModelLimit(null)
    void window.api.ollama
      .showModel(selectedModel)
      .then((detail) => {
        if (cancelled) return
        const next = detail.contextLength
        if (next && next > 0) setModelLimit(next)
      })
      .catch(() => {
        // Keep null / last successful value from a later resolve; don't blank on errors.
      })
    return () => {
      cancelled = true
    }
  }, [selectedModel, ollamaOk])

  const contextLimit =
    (contextUsage && contextUsage.limit > 0 ? contextUsage.limit : null) ??
    modelLimit

  const contextUsed = useMemo(() => {
    const draftTokens = estimateDraftTokens(draft, attachments)
    if (contextUsage && contextUsage.used > 0) {
      return contextUsage.used + draftTokens
    }
    return (
      estimateMessageTokens(messages) +
      estimateToolSchemaTokens(tools) +
      draftTokens
    )
  }, [attachments, contextUsage, draft, messages, tools])

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
    stickToBottomRef.current = true
    onSend({
      content: built.content,
      images: built.images,
      attachmentLabels: built.labels
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
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-[#f0f4f8]">
            Chat
            {busy && (
              <span className="header-live inline-flex items-center gap-1.5 rounded-full border border-[#2a3a4d] bg-[#161d27] px-2 py-0.5 text-[10px] font-normal uppercase tracking-wider text-[#8b9aab]">
                <span className="header-live-dot h-1.5 w-1.5 rounded-full bg-[var(--activity-accent,#6eb5ff)]" />
                Live
              </span>
            )}
          </div>
          <div
            className={`flex items-center gap-1.5 text-xs ${
              ollamaOk ? 'text-emerald-400/90' : 'text-rose-300/90'
            }`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                ollamaOk ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
              aria-hidden
            />
            {ollamaOk ? 'Connected' : 'Disconnected'}
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
          <button
            type="button"
            onClick={onClear}
            className="rounded border border-[#2a3a4d] px-3 py-1 text-xs text-[#c5d0dc] hover:bg-[#1a2430]"
          >
            Clear
          </button>
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
        className="flex-1 space-y-3 overflow-y-auto px-5 py-4 outline-none"
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
                  <MessageMeta createdAt={m.createdAt} model={m.model} align="right" />
                </div>
              </div>
            )
          }
          if (m.kind === 'assistant') {
            return (
              <div key={m.id} className="msg-enter group/assistant flex justify-start">
                <div className="max-w-[85%]">
                  <div className="relative rounded-2xl rounded-bl-md border border-[#2a3a4d] bg-[#161d27] px-3.5 py-2 text-sm leading-relaxed text-[#e7ecf1]">
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
                    responseMs={m.streaming ? undefined : m.responseMs}
                    model={m.model}
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
                startedAt={m.streaming ? activity.startedAt : undefined}
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
              />
            )
          }
          if (m.kind === 'notice') {
            return (
              <div
                key={m.id}
                className="msg-enter flex justify-center py-1"
                title={m.summary ? 'Earlier messages were compacted for the model' : undefined}
              >
                <div className="inline-flex items-center gap-2 rounded-full border border-[#2a3a4d] bg-[#121820]/90 px-3 py-1 text-[11px] text-[#8b9aab]">
                  <span className="h-1 w-1 rounded-full bg-[#9ec5f0]" aria-hidden="true" />
                  <span>{m.content}</span>
                </div>
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

      <form onSubmit={submit} className="px-5 pb-5 pt-2">
        {!ollamaOk && (
          <p className="mb-2 text-xs text-amber-300/90">
            Ollama is offline — check the sidebar connection.
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
                  : 'Send a message'
            }
            disabled={!ollamaOk}
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

          {ollamaOk && selectedModel && contextLimit && contextLimit > 0 ? (
            <ContextMeter used={contextUsed} limit={contextLimit} />
          ) : null}

          <div className="absolute bottom-2.5 right-2.5 flex items-center gap-2">
            {!modelIsImageGen && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!ollamaOk || busy}
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
                    const tooltipText =
                      otherTags.length > 0 ? otherTags.join(' · ') : undefined

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

function ContextMeter({
  used,
  limit
}: {
  used: number
  limit: number
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, (used / limit) * 100))
  const color = contextUsageColor(pct)
  return (
    <div
      className="pointer-events-none absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-11rem)] items-center gap-2"
      title="Tokens that will be sent on the next prompt vs the live window (min of Ollama’s context setting and the model maximum)."
    >
      <div className="h-1 w-14 overflow-hidden rounded-full bg-[#2a313a]">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span
        className="truncate font-mono text-[10px] tabular-nums"
        style={{ color }}
      >
        {formatTokenCount(used)} / {formatTokenCount(limit)}
      </span>
    </div>
  )
}
