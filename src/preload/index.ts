import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentSkill,
  AgentSkillInput,
  AppConfig,
  CatalogSkill,
  ChatEnqueueResult,
  ChatEvent,
  ChatQueueState,
  ChatSendPayload,
  ChatSession,
  HtmlPreviewCreatePayload,
  HtmlPreviewCreateResult,
  LibraryModelDetail,
  LibrarySearchParams,
  LibrarySearchResult,
  McpServerConfig,
  McpToolInfo,
  LlmProvider,
  OpenAiStatus,
  OllamaModel,
  OllamaModelDetails,
  OllamaStatus,
  PullProgressEvent,
  ScheduleNotificationPayload,
  SessionsState,
  SkillImportResult,
  TelegramMirrorMode,
  TelegramSchedule,
  TelegramStatus
} from '../shared/types'

export type ServerWithStatus = McpServerConfig & { connected: boolean }

const api = {
  platform: process.platform as NodeJS.Platform,
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setShowThinking: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('config:setShowThinking', enabled),
  setMaxToolIterations: (value: number): Promise<number> =>
    ipcRenderer.invoke('config:setMaxToolIterations', value),
  setLlmProvider: (provider: LlmProvider): Promise<LlmProvider> =>
    ipcRenderer.invoke('config:setLlmProvider', provider),
  setOpenaiEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('config:setOpenaiEnabled', enabled),
  setOpenaiApiKey: (key: string | null): Promise<string | null> =>
    ipcRenderer.invoke('config:setOpenaiApiKey', key),
  setOpenaiModelEnabled: (id: string, enabled: boolean): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('config:setOpenaiModelEnabled', id, enabled),
  setSelectedModelForProvider: (
    provider: LlmProvider,
    model: string | null
  ): Promise<void> => ipcRenderer.invoke('config:setSelectedModelForProvider', provider, model),
  setDefaultImageModel: (model: string | null): Promise<string | null> =>
    ipcRenderer.invoke('config:setDefaultImageModel', model),

  llm: {
    getEffectiveProvider: (): Promise<{
      configured: LlmProvider
      effective: LlmProvider
      fallback: boolean
      reason?: string
    }> => ipcRenderer.invoke('llm:getEffectiveProvider')
  },

  openai: {
    validateAndFetchModels: (): Promise<AppConfig> =>
      ipcRenderer.invoke('openai:validateAndFetchModels'),
    refreshModels: (): Promise<AppConfig> =>
      ipcRenderer.invoke('openai:refreshModels'),
    getStatus: (): Promise<OpenAiStatus> => ipcRenderer.invoke('openai:getStatus'),
    listChatModels: (): Promise<OllamaModel[]> =>
      ipcRenderer.invoke('openai:listChatModels')
  },

  ollama: {
    getStatus: (): Promise<OllamaStatus> => ipcRenderer.invoke('ollama:getStatus'),
    listModels: (): Promise<OllamaModel[]> => ipcRenderer.invoke('ollama:listModels'),
    showModel: (model: string): Promise<OllamaModelDetails> =>
      ipcRenderer.invoke('ollama:showModel', model),
    deleteModel: (model: string): Promise<void> =>
      ipcRenderer.invoke('ollama:deleteModel', model),
    pullModel: (model: string): Promise<void> =>
      ipcRenderer.invoke('ollama:pullModel', model),
    abortPull: (): Promise<void> => ipcRenderer.invoke('ollama:abortPull'),
    searchLibrary: (params: LibrarySearchParams): Promise<LibrarySearchResult> =>
      ipcRenderer.invoke('ollama:searchLibrary', params),
    getLibraryModel: (name: string): Promise<LibraryModelDetail> =>
      ipcRenderer.invoke('ollama:getLibraryModel', name),
    getLibraryReadme: (name: string): Promise<string | undefined> =>
      ipcRenderer.invoke('ollama:getLibraryReadme', name),
    setBaseUrl: (url: string): Promise<string> =>
      ipcRenderer.invoke('ollama:setBaseUrl', url),
    getSelectedModel: (): Promise<string | null> =>
      ipcRenderer.invoke('ollama:getSelectedModel'),
    setSelectedModel: (model: string | null): Promise<void> =>
      ipcRenderer.invoke('ollama:setSelectedModel', model),
    onPullProgress: (
      callback: (event: PullProgressEvent) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        event: PullProgressEvent
      ): void => {
        callback(event)
      }
      ipcRenderer.on('models:pullProgress', handler)
      return () => {
        ipcRenderer.removeListener('models:pullProgress', handler)
      }
    }
  },

  mcp: {
    listServers: (): Promise<ServerWithStatus[]> => ipcRenderer.invoke('mcp:listServers'),
    upsertServer: (server: McpServerConfig): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke('mcp:upsertServer', server),
    removeServer: (id: string): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke('mcp:removeServer', id),
    connect: (id: string): Promise<McpToolInfo[]> => ipcRenderer.invoke('mcp:connect', id),
    disconnect: (id: string): Promise<void> => ipcRenderer.invoke('mcp:disconnect', id),
    listTools: (): Promise<McpToolInfo[]> => ipcRenderer.invoke('mcp:listTools')
  },

  skills: {
    list: (): Promise<AgentSkill[]> => ipcRenderer.invoke('skills:list'),
    upsert: (input: AgentSkillInput): Promise<AgentSkill> =>
      ipcRenderer.invoke('skills:upsert', input),
    setEnabled: (id: string, enabled: boolean): Promise<AgentSkill> =>
      ipcRenderer.invoke('skills:setEnabled', id, enabled),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('skills:delete', id),
    listCatalog: (): Promise<CatalogSkill[]> =>
      ipcRenderer.invoke('skills:listCatalog'),
    addFromCatalog: (id: string): Promise<void> =>
      ipcRenderer.invoke('skills:addFromCatalog', id),
    openRoot: (): Promise<void> => ipcRenderer.invoke('skills:openRoot'),
    openDir: (id: string): Promise<void> =>
      ipcRenderer.invoke('skills:openDir', id),
    importFromFolder: (): Promise<SkillImportResult> =>
      ipcRenderer.invoke('skills:importFromFolder')
  },

  sessions: {
    list: (): Promise<SessionsState> => ipcRenderer.invoke('sessions:list'),
    create: (): Promise<SessionsState> => ipcRenderer.invoke('sessions:create'),
    setActive: (id: string): Promise<SessionsState> =>
      ipcRenderer.invoke('sessions:setActive', id),
    update: (
      id: string,
      patch: Partial<Pick<ChatSession, 'title' | 'uiMessages' | 'history'>>
    ): Promise<SessionsState> => ipcRenderer.invoke('sessions:update', id, patch),
    delete: (id: string): Promise<SessionsState> =>
      ipcRenderer.invoke('sessions:delete', id),
    generateTitle: (id: string, prompt: string): Promise<string> =>
      ipcRenderer.invoke('sessions:generateTitle', id, prompt),
    onChanged: (callback: (state: SessionsState) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, state: SessionsState): void => {
        callback(state)
      }
      ipcRenderer.on('sessions:changed', handler)
      return () => {
        ipcRenderer.removeListener('sessions:changed', handler)
      }
    }
  },

  chat: {
    send: (payload: ChatSendPayload): Promise<ChatEnqueueResult> =>
      ipcRenderer.invoke('chat:send', payload),
    abort: (): Promise<void> => ipcRenderer.invoke('chat:abort'),
    onEvent: (callback: (event: ChatEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: ChatEvent): void => {
        callback(event)
      }
      ipcRenderer.on('chat:event', handler)
      return () => {
        ipcRenderer.removeListener('chat:event', handler)
      }
    }
  },

  queue: {
    getState: (): Promise<ChatQueueState> => ipcRenderer.invoke('queue:getState'),
    removeSession: (sessionId: string): Promise<ChatQueueState> =>
      ipcRenderer.invoke('queue:removeSession', sessionId),
    onChanged: (callback: (state: ChatQueueState) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, state: ChatQueueState): void => {
        callback(state)
      }
      ipcRenderer.on('queue:changed', handler)
      return () => {
        ipcRenderer.removeListener('queue:changed', handler)
      }
    }
  },

  htmlPreview: {
    create: (payload: HtmlPreviewCreatePayload): Promise<HtmlPreviewCreateResult> =>
      ipcRenderer.invoke('htmlPreview:create', payload),
    destroy: (id: string): Promise<void> =>
      ipcRenderer.invoke('htmlPreview:destroy', id)
  },

  telegram: {
    getStatus: (): Promise<TelegramStatus> =>
      ipcRenderer.invoke('telegram:getStatus'),
    setToken: (token: string | null): Promise<TelegramStatus> =>
      ipcRenderer.invoke('telegram:setToken', token),
    setEnabled: (enabled: boolean): Promise<TelegramStatus> =>
      ipcRenderer.invoke('telegram:setEnabled', enabled),
    setAllowedUserIds: (ids: number[]): Promise<number[]> =>
      ipcRenderer.invoke('telegram:setAllowedUserIds', ids),
    setMirrorMode: (mode: TelegramMirrorMode): Promise<TelegramMirrorMode> =>
      ipcRenderer.invoke('telegram:setMirrorMode', mode)
  },

  schedules: {
    list: (): Promise<TelegramSchedule[]> => ipcRenderer.invoke('schedules:list'),
    create: (
      input: Omit<
        TelegramSchedule,
        'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastRunStatus' | 'lastRunError'
      >
    ): Promise<TelegramSchedule> => ipcRenderer.invoke('schedules:create', input),
    update: (schedule: TelegramSchedule): Promise<TelegramSchedule> =>
      ipcRenderer.invoke('schedules:update', schedule),
    delete: (id: string): Promise<TelegramSchedule[]> =>
      ipcRenderer.invoke('schedules:delete', id),
    runNow: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('schedules:runNow', id),
    onChanged: (callback: (schedules: TelegramSchedule[]) => void): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        schedules: TelegramSchedule[]
      ): void => {
        callback(schedules)
      }
      ipcRenderer.on('schedules:changed', handler)
      return () => {
        ipcRenderer.removeListener('schedules:changed', handler)
      }
    },
    onNotification: (
      callback: (payload: ScheduleNotificationPayload) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: ScheduleNotificationPayload
      ): void => {
        callback(payload)
      }
      ipcRenderer.on('schedules:notification', handler)
      return () => {
        ipcRenderer.removeListener('schedules:notification', handler)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
