export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}

export interface CatalogInstallEnvHint {
  name: string
  description?: string
  required?: boolean
}

export interface CatalogInstall {
  command: string
  args: string[]
  envHints?: CatalogInstallEnvHint[]
}

export interface CatalogServer {
  id: string
  name: string
  description: string
  category: string
  url: string
  language?: string
  tags?: string[]
  official?: boolean
  install?: CatalogInstall
}

export type TelegramMirrorMode = 'full' | 'final'

export type LlmProvider = 'ollama' | 'openai'

export interface OpenAiModelEntry {
  id: string
  ownedBy?: string
  created?: number
}

export interface SelectedModelByProvider {
  ollama: string | null
  openai: string | null
}

export interface OpenAiStatus {
  enabled: boolean
  validationOk: boolean
  validationError: string | null
  catalogCount: number
  enabledCount: number
}

export interface AppConfig {
  ollamaBaseUrl: string
  /** @deprecated Use selectedModelByProvider; kept for migration and UI compat */
  selectedModel: string | null
  llmProvider: LlmProvider
  openaiEnabled: boolean
  openaiApiKey: string | null
  openaiValidationOk: boolean
  openaiValidationError: string | null
  openaiModelsCatalog: OpenAiModelEntry[]
  openaiModelEnabled: Record<string, boolean>
  selectedModelByProvider: SelectedModelByProvider
  servers: McpServerConfig[]
  /** When true, model reasoning/thinking is shown in the chat transcript. */
  showThinking: boolean
  /** Max tool-call rounds per user turn (clamped 8–100). */
  maxToolIterations: number
  telegramBotToken: string | null
  telegramEnabled: boolean
  telegramAllowedUserIds: number[]
  telegramMirrorMode: TelegramMirrorMode
  /** Preferred image model for generate_image tool; null = Auto (first installed). */
  defaultImageModel: string | null
}

export interface TelegramStatus {
  running: boolean
  error?: string
  botUsername?: string
}

export interface OllamaModel {
  name: string
  size: number
  modifiedAt: string
  /** Display tags derived from Ollama model metadata (capabilities, family, size, …). */
  tags: string[]
  capabilities?: string[]
  family?: string
  parameterSize?: string
  quantization?: string
}

export interface OllamaModelDetails {
  name: string
  modelfile?: string
  parameters?: string
  template?: string
  system?: string
  details?: {
    family?: string
    families?: string[]
    parameter_size?: string
    quantization_level?: string
    format?: string
    parent_model?: string
  }
  capabilities?: string[]
  model_info?: Record<string, unknown>
  size?: number
  modifiedAt?: string
  /** Effective Ollama num_ctx (not the architecture maximum). */
  contextLength?: number
}

export interface PullProgressEvent {
  model: string
  status: string
  digest?: string
  total?: number
  completed?: number
  error?: string
  done?: boolean
}

export type LibraryCapability =
  | 'tools'
  | 'vision'
  | 'embedding'
  | 'thinking'
  | 'cloud'

export interface LibraryModelSummary {
  name: string
  description: string
  capabilities: LibraryCapability[]
  pulls?: string
  tagCount?: string
  updated?: string
  /** Parameter-size badges from search (e.g. 1b, 3b). */
  sizes?: string[]
  /** Smallest available size label for list cards (param or disk). */
  minSize?: string
}

export interface LibraryModelTag {
  name: string
  size?: string
  context?: string
  input?: string
  digest?: string
  updated?: string
}

export interface LibraryModelDetail {
  name: string
  description: string
  capabilities: LibraryCapability[]
  pulls?: string
  tags: LibraryModelTag[]
  readme?: string
}

export interface LibrarySearchParams {
  q?: string
  category?: LibraryCapability | null
  order?: 'popular' | 'newest'
  page?: number
}

export interface LibrarySearchResult {
  models: LibraryModelSummary[]
  page: number
  hasMore: boolean
}

export interface OllamaStatus {
  ok: boolean
  baseUrl: string
  error?: string
  /** Ollama server version from /api/version when available. */
  version?: string
  /**
   * False when this Ollama build rejects image-generation models
   * (experimental support removed in v0.32.6+).
   */
  imageGenSupported?: boolean
}

export interface McpToolInfo {
  serverId: string
  serverName: string
  name: string
  prefixedName: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system'

export interface ChatToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ChatMessage {
  role: ChatRole
  content: string
  /** Raw base64 image payloads for Ollama vision models (no data-URL prefix). */
  images?: string[]
  tool_calls?: ChatToolCall[]
  tool_name?: string
}

export type ActivityPhase =
  | 'idle'
  | 'thinking'
  | 'generating'
  | 'tool'
  | 'synthesizing'
  | 'compacting'

export interface TokenUsageBreakdown {
  provider: 'ollama' | 'openai'
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens?: number
  reasoningTokens?: number
  /** Ollama sums (same as prompt/completion when mapped). */
  ollamaPromptEval?: number
  ollamaEval?: number
}

export type ChatEvent =
  | { type: 'user'; content: string; turnId?: string; sessionId?: string }
  | {
      type: 'provider_fallback'
      message: string
      turnId?: string
      sessionId?: string
    }
  | {
      type: 'status'
      phase: Exclude<ActivityPhase, 'idle'>
      detail?: string
      turnId?: string
      sessionId?: string
    }
  | { type: 'thinking'; content: string; turnId?: string; sessionId?: string }
  | { type: 'chunk'; content: string; turnId?: string; sessionId?: string }
  | {
      type: 'assistant_done'
      content: string
      turnId?: string
      sessionId?: string
      contextUsed?: number
      contextLimit?: number
      /** Generated tokens per second for this reply (Ollama eval_count / eval_duration). */
      tokensPerSec?: number
      tokenUsage?: TokenUsageBreakdown
      /** True when usage sums more than one model call in the turn. */
      multiCallTurn?: boolean
    }
  | {
      type: 'assistant_images'
      images: string[]
      imageModel?: string
      mime?: string
      turnId?: string
      sessionId?: string
      tokenUsage?: TokenUsageBreakdown
      contextUsed?: number
      contextLimit?: number
    }
  | {
      type: 'tool_start'
      id: string
      name: string
      arguments: Record<string, unknown>
      turnId?: string
      sessionId?: string
    }
  | {
      type: 'tool_result'
      id: string
      name: string
      ok: boolean
      result: string
      turnId?: string
      sessionId?: string
    }
  | { type: 'done'; turnId?: string; sessionId?: string }
  | { type: 'error'; message: string; turnId?: string; sessionId?: string }
  | { type: 'context'; used: number; limit: number; turnId?: string; sessionId?: string }
  /** Model history was compacted; renderer should replace session history. */
  | { type: 'compacted'; messages: ChatMessage[]; turnId?: string; sessionId?: string }
  /** Lightweight UI notice (e.g. summarization). */
  | {
      type: 'notice'
      content: string
      summary?: string
      turnId?: string
      sessionId?: string
    }

export interface ChatSendPayload {
  model: string
  messages: ChatMessage[]
  sessionId: string
  /** Client-generated id so the UI can ignore stale events from aborted turns. */
  turnId: string
  /** Last Ollama prompt+eval count from this session (drives compaction). */
  contextUsed?: number
  /** Skill invoked via `/name` in the composer. */
  invokedSkill?: string
}

export type SessionQueueStatus = 'idle' | 'running' | 'queued'

export interface ChatQueueState {
  running: { sessionId: string; turnId: string } | null
  queued: Array<{ sessionId: string; turnId: string }>
}

export type ChatEnqueueResult =
  | { ok: true; queued: boolean }
  | { ok: false; error: string }

export type UiMessage =
  | {
      kind: 'user'
      id: string
      content: string
      createdAt: string
      attachmentLabels?: string[]
      /** Model selected for this turn. */
      model?: string
      /** Waiting for global agent queue. */
      queueStatus?: 'queued'
    }
  | {
      kind: 'assistant'
      id: string
      content: string
      createdAt: string
      streaming?: boolean
      /** Renderer-only: reply segment start epoch ms (live timer). */
      startedAt?: number
      /** Reply segment duration once streaming finishes. */
      durationMs?: number
      /** Wall-clock duration from user send to this reply finishing. */
      responseMs?: number
      /** Generated tokens per second for this reply. */
      tokensPerSec?: number
      /** Model that generated this reply. */
      model?: string
      /** Context tokens used when this reply finished. */
      contextUsed?: number
      /** Live context window at that time. */
      contextLimit?: number
      /** Generated image data URLs (e.g. data:image/png;base64,...). */
      images?: string[]
      /** Model used to generate the attached images. */
      imageModel?: string
      tokenUsage?: TokenUsageBreakdown
      multiCallTurn?: boolean
    }
  | {
      kind: 'thinking'
      id: string
      content: string
      createdAt: string
      streaming?: boolean
      model?: string
      /** Renderer-only: segment start epoch ms (live timer). */
      startedAt?: number
      /** Segment duration once thinking finishes. */
      durationMs?: number
      /** Wall-clock from user send to thinking finish. */
      elapsedMs?: number
    }
  | {
      kind: 'tool'
      id: string
      name: string
      arguments: Record<string, unknown>
      status: 'running' | 'done' | 'error'
      createdAt: string
      result?: string
      model?: string
      /** Renderer-only: segment start epoch ms (live timer). */
      startedAt?: number
      /** Segment duration once tool finishes. */
      durationMs?: number
      /** Wall-clock from user send to tool finish. */
      elapsedMs?: number
    }
  | {
      kind: 'error'
      id: string
      content: string
      createdAt: string
      model?: string
    }
  | {
      kind: 'notice'
      id: string
      content: string
      createdAt: string
      /** Optional compacted summary text for later expand UI. */
      summary?: string
    }

export type SessionOrigin = 'desktop' | 'telegram'

export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  uiMessages: UiMessage[]
  history: ChatMessage[]
  origin?: SessionOrigin
}

export interface SessionsState {
  sessions: ChatSession[]
  activeSessionId: string | null
  telegramActiveSessionId: string | null
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  body: string
  enabled: boolean
}

export type SkillImportResult =
  | { canceled: true }
  | { canceled: false; skill: AgentSkill }

export interface AgentSkillInput {
  id?: string
  name: string
  description: string
  body: string
  enabled?: boolean
}

export interface CatalogSkill {
  id: string
  name: string
  description: string
  url: string
  source: string
}

export interface HtmlPreviewCreatePayload {
  html: string
  allowScripts: boolean
  allowRemoteScripts: boolean
}

export interface HtmlPreviewCreateResult {
  id: string
  url: string
}

export type ScheduleRecurrence =
  | { type: 'interval'; everyMinutes: number }
  | { type: 'cron'; expression: string; timezone?: string }

export type ScheduleDelivery =
  | { mode: 'telegram' }
  | { mode: 'notification'; channel: 'system' | 'in-app' }
  | { mode: 'both'; notificationChannel: 'system' | 'in-app' }

export type ScheduleRunStatus = 'ok' | 'error' | 'skipped'

export interface TelegramSchedule {
  id: string
  name: string
  prompt: string
  enabled: boolean
  recurrence: ScheduleRecurrence
  delivery: ScheduleDelivery
  /** Target chat session (telegram or desktop depending on delivery). */
  sessionId: string | null
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  lastRunStatus?: ScheduleRunStatus
  lastRunError?: string
}

export interface ScheduleNotificationPayload {
  scheduleId: string
  scheduleName: string
  snippet: string
  sessionId: string
}
