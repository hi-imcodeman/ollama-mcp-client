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

export interface AppConfig {
  ollamaBaseUrl: string
  selectedModel: string | null
  servers: McpServerConfig[]
  /** When true, model reasoning/thinking is shown in the chat transcript. */
  showThinking: boolean
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

export type ChatEvent =
  | { type: 'user'; content: string; turnId?: string }
  | {
      type: 'status'
      phase: Exclude<ActivityPhase, 'idle'>
      detail?: string
      turnId?: string
    }
  | { type: 'thinking'; content: string; turnId?: string }
  | { type: 'chunk'; content: string; turnId?: string }
  | { type: 'assistant_done'; content: string; turnId?: string }
  | {
      type: 'assistant_images'
      images: string[]
      mime?: string
      turnId?: string
    }
  | {
      type: 'tool_start'
      id: string
      name: string
      arguments: Record<string, unknown>
      turnId?: string
    }
  | {
      type: 'tool_result'
      id: string
      name: string
      ok: boolean
      result: string
      turnId?: string
    }
  | { type: 'done'; turnId?: string }
  | { type: 'error'; message: string; turnId?: string }
  | { type: 'context'; used: number; limit: number; turnId?: string }
  /** Model history was compacted; renderer should replace session history. */
  | { type: 'compacted'; messages: ChatMessage[]; turnId?: string }
  /** Lightweight UI notice (e.g. summarization). */
  | { type: 'notice'; content: string; summary?: string; turnId?: string }

export interface ChatSendPayload {
  model: string
  messages: ChatMessage[]
  /** Client-generated id so the UI can ignore stale events from aborted turns. */
  turnId: string
  /** Last Ollama prompt+eval count from this session (drives compaction). */
  contextUsed?: number
}

export type UiMessage =
  | {
      kind: 'user'
      id: string
      content: string
      createdAt: string
      attachmentLabels?: string[]
      /** Model selected for this turn. */
      model?: string
    }
  | {
      kind: 'assistant'
      id: string
      content: string
      createdAt: string
      streaming?: boolean
      /** Wall-clock duration from user send to this reply finishing. */
      responseMs?: number
      /** Model that generated this reply. */
      model?: string
      /** Generated image data URLs (e.g. data:image/png;base64,...). */
      images?: string[]
    }
  | {
      kind: 'thinking'
      id: string
      content: string
      createdAt: string
      streaming?: boolean
      model?: string
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

export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  uiMessages: UiMessage[]
  history: ChatMessage[]
}

export interface SessionsState {
  sessions: ChatSession[]
  activeSessionId: string | null
}
