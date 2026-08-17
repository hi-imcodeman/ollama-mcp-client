import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  ChatEvent,
  ChatSendPayload,
  ChatSession,
  LibraryModelDetail,
  LibrarySearchParams,
  LibrarySearchResult,
  McpServerConfig,
  McpToolInfo,
  OllamaModel,
  OllamaModelDetails,
  OllamaStatus,
  PullProgressEvent,
  SessionsState
} from '../shared/types'

export type ServerWithStatus = McpServerConfig & { connected: boolean }

const api = {
  platform: process.platform as NodeJS.Platform,
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setShowThinking: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('config:setShowThinking', enabled),

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
      ipcRenderer.invoke('sessions:delete', id)
  },

  chat: {
    send: (payload: ChatSendPayload): Promise<void> =>
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
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
