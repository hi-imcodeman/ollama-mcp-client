import { BrowserWindow, dialog, type IpcMain } from 'electron'
import type {
  AgentSkillInput,
  ChatSendPayload,
  ChatSession,
  HtmlPreviewCreatePayload,
  LibrarySearchParams,
  LlmProvider,
  McpServerConfig,
  PullProgressEvent,
  SkillImportResult,
  TelegramMirrorMode,
  TelegramSchedule
} from '../shared/types'
import {
  abortCurrentTurn,
  enqueueTurn,
  getQueueState,
  removeSessionTurns
} from './chat-queue'
import { clearLatestGeneratedImage } from './agent'
import {
  createSession,
  createScheduleRecord,
  deleteScheduleRecord,
  deleteSession,
  ensureActiveSession,
  getConfig,
  getOpenaiApiKey,
  getSchedule,
  getSelectedModel,
  getSessionsState,
  listSchedules,
  listServers,
  mergeOpenaiCatalog,
  patchScheduleRun,
  removeServer,
  setActiveSession,
  setLlmProvider,
  setOllamaBaseUrl,
  setOpenaiApiKey,
  setOpenaiEnabled,
  setOpenaiModelEnabled,
  setOpenaiValidationOk,
  setSelectedModel,
  setSelectedModelForProvider,
  setServerEnabled,
  setShowThinking,
  setMaxToolIterations,
  getDefaultImageModel,
  setDefaultImageModel,
  setTelegramAllowedUserIds,
  setTelegramBotToken,
  setTelegramEnabled,
  setTelegramMirrorMode,
  updateSession,
  upsertSchedule,
  upsertServer
} from './config-store'
import {
  generateSessionTitle,
  snippetFromPrompt
} from './session-title'
import { mcpManager } from './mcp-manager'
import { getLibraryModel, getLibraryReadme, searchLibrary } from './ollama-library'
import {
  deleteSkill,
  importSkillFromFolder,
  listSkills,
  openSkillDir,
  openSkillsRoot,
  setSkillEnabled,
  upsertSkill
} from './skills'
import { addCatalogSkill, listCatalogSkills } from './skill-catalog'
import {
  abortPull,
  deleteModel,
  getOllamaStatus,
  listModels,
  pullModel,
  showModel
} from './ollama'
import {
  createHtmlPreview,
  destroyHtmlPreview
} from './html-preview'
import { broadcastSessionsChanged } from './sessions-broadcast'
import { reloadScheduleRunner, runScheduleNow } from './schedule-runner'
import { broadcastSchedulesChanged } from './schedules-broadcast'
import {
  getOpenAiStatus,
  getLlmProvider as getLlmProviderAdapter,
  resolveEffectiveLlmProvider
} from './llm'
import { fetchOpenAiModels, validateOpenAiKey } from './openai-client'
import {
  getTelegramBotStatus,
  restartTelegramBot,
  stopTelegramBot
} from './telegram-bot'

async function validateOpenAiAndFetchCatalog(): Promise<ReturnType<typeof getConfig>> {
  const key = getOpenaiApiKey()
  if (!key) {
    setOpenaiValidationOk(false, 'API key not configured')
    return getConfig()
  }
  const result = await validateOpenAiKey(key)
  if (!result.ok) {
    setOpenaiValidationOk(false, result.error ?? 'Validation failed')
    return getConfig()
  }
  const models = await fetchOpenAiModels(key)
  mergeOpenaiCatalog(models)
  setOpenaiValidationOk(true)
  return getConfig()
}

function emitPullProgress(event: PullProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('models:pullProgress', event)
  }
}

export async function restoreMcpConnections(): Promise<void> {
  const servers = listServers().filter((s) => s.enabled)
  for (const server of servers) {
    try {
      await mcpManager.connect(server)
      console.log(`[mcp] restored connection: ${server.name}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[mcp] failed to restore ${server.name}: ${message}`)
    }
  }
}

export function registerIpc(ipcMain: IpcMain): void {
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:setShowThinking', (_e, enabled: boolean) =>
    setShowThinking(enabled)
  )
  ipcMain.handle('config:setMaxToolIterations', (_e, value: number) =>
    setMaxToolIterations(value)
  )
  ipcMain.handle('config:setLlmProvider', (_e, provider: LlmProvider) =>
    setLlmProvider(provider)
  )
  ipcMain.handle('config:setOpenaiEnabled', (_e, enabled: boolean) =>
    setOpenaiEnabled(enabled)
  )
  ipcMain.handle('config:setOpenaiApiKey', (_e, key: string | null) =>
    setOpenaiApiKey(key)
  )
  ipcMain.handle('config:setOpenaiModelEnabled', (_e, id: string, enabled: boolean) =>
    setOpenaiModelEnabled(id, enabled)
  )
  ipcMain.handle('config:setSelectedModelForProvider', (
    _e,
    provider: LlmProvider,
    model: string | null
  ) => setSelectedModelForProvider(provider, model))
  ipcMain.handle('config:setDefaultImageModel', (_e, model: string | null) =>
    setDefaultImageModel(model)
  )
  ipcMain.handle('openai:validateAndFetchModels', () => validateOpenAiAndFetchCatalog())
  ipcMain.handle('openai:refreshModels', () => validateOpenAiAndFetchCatalog())
  ipcMain.handle('openai:getStatus', () => getOpenAiStatus())
  ipcMain.handle('openai:listChatModels', () =>
    getLlmProviderAdapter('openai').listModelsForChat()
  )
  ipcMain.handle('llm:getEffectiveProvider', () => resolveEffectiveLlmProvider())

  ipcMain.handle('ollama:getStatus', () => getOllamaStatus())
  ipcMain.handle('ollama:listModels', () => listModels())
  ipcMain.handle('ollama:showModel', (_e, model: string) => showModel(model))
  ipcMain.handle('ollama:deleteModel', async (_e, model: string) => {
    await deleteModel(model)
    const selected = getSelectedModel()
    if (selected === model) {
      setSelectedModel(null)
    }
    const defaultImage = getDefaultImageModel()
    if (defaultImage === model) {
      setDefaultImageModel(null)
    }
  })
  ipcMain.handle('ollama:pullModel', async (_e, model: string) => {
    await pullModel(model, emitPullProgress)
  })
  ipcMain.handle('ollama:abortPull', () => {
    abortPull()
  })
  ipcMain.handle('ollama:searchLibrary', (_e, params: LibrarySearchParams) =>
    searchLibrary(params ?? {})
  )
  ipcMain.handle('ollama:getLibraryModel', (_e, name: string) =>
    getLibraryModel(name)
  )
  ipcMain.handle('ollama:getLibraryReadme', (_e, name: string) =>
    getLibraryReadme(name)
  )
  ipcMain.handle('ollama:setBaseUrl', (_e, url: string) => setOllamaBaseUrl(url))
  ipcMain.handle('ollama:getSelectedModel', () => getSelectedModel())
  ipcMain.handle('ollama:setSelectedModel', (_e, model: string | null) => {
    setSelectedModel(model)
  })

  ipcMain.handle('mcp:listServers', () => {
    const servers = listServers()
    const connected = new Set(mcpManager.getConnectedIds())
    return servers.map((s) => ({
      ...s,
      connected: connected.has(s.id)
    }))
  })

  ipcMain.handle('mcp:upsertServer', async (_e, server: McpServerConfig) => {
    const servers = upsertServer(server)
    if (mcpManager.isConnected(server.id)) {
      if (server.enabled) {
        await mcpManager.connect(server)
      } else {
        await mcpManager.disconnect(server.id)
      }
    } else if (server.enabled) {
      try {
        await mcpManager.connect(server)
      } catch {
        // leave enabled so next launch / manual connect can retry
      }
    }
    return servers
  })

  ipcMain.handle('mcp:removeServer', async (_e, id: string) => {
    if (mcpManager.isConnected(id)) {
      await mcpManager.disconnect(id)
    }
    return removeServer(id)
  })

  ipcMain.handle('mcp:connect', async (_e, id: string) => {
    const server = listServers().find((s) => s.id === id)
    if (!server) throw new Error('Server not found')
    const tools = await mcpManager.connect(server)
    setServerEnabled(id, true)
    return tools
  })

  ipcMain.handle('mcp:disconnect', async (_e, id: string) => {
    await mcpManager.disconnect(id)
    setServerEnabled(id, false)
  })

  ipcMain.handle('mcp:listTools', () => mcpManager.listAllTools())

  ipcMain.handle('skills:list', () => listSkills())
  ipcMain.handle('skills:upsert', (_e, input: AgentSkillInput) => upsertSkill(input))
  ipcMain.handle('skills:setEnabled', (_e, id: string, enabled: boolean) =>
    setSkillEnabled(id, enabled)
  )
  ipcMain.handle('skills:delete', (_e, id: string) => {
    deleteSkill(id)
  })
  ipcMain.handle('skills:listCatalog', () => listCatalogSkills())
  ipcMain.handle('skills:addFromCatalog', (_e, id: string) => addCatalogSkill(id))
  ipcMain.handle('skills:openRoot', () => openSkillsRoot())
  ipcMain.handle('skills:openDir', (_e, id: string) => openSkillDir(id))
  ipcMain.handle(
    'skills:importFromFolder',
    async (e): Promise<SkillImportResult> => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = {
        title: 'Add skill from folder',
        properties: ['openDirectory' as const]
      }
      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true }
      }
      const skill = importSkillFromFolder(result.filePaths[0])
      return { canceled: false, skill }
    }
  )

  ipcMain.handle('sessions:list', () => ensureActiveSession())
  ipcMain.handle('sessions:create', () => {
    createSession()
    const state = getSessionsState()
    broadcastSessionsChanged()
    return state
  })
  ipcMain.handle('sessions:setActive', (_e, id: string) => {
    const state = setActiveSession(id)
    broadcastSessionsChanged()
    return state
  })
  ipcMain.handle(
    'sessions:update',
    (
      _e,
      id: string,
      patch: Partial<Pick<ChatSession, 'title' | 'uiMessages' | 'history'>>
    ) => {
      updateSession(id, patch)
      return getSessionsState()
    }
  )
  ipcMain.handle('sessions:delete', (_e, id: string) => {
    removeSessionTurns(id)
    clearLatestGeneratedImage(id)
    const state = deleteSession(id)
    broadcastSessionsChanged()
    return state
  })
  ipcMain.handle(
    'sessions:generateTitle',
    async (_e, id: string, prompt: string) => {
      const fallback = snippetFromPrompt(prompt ?? '')
      const title = await generateSessionTitle(prompt ?? '', fallback)
      try {
        const current = getSessionsState().sessions.find((s) => s.id === id)
        // Skip if the chat was cleared or deleted while the title model ran.
        if (!current) return title
        if (current.uiMessages.length === 0 && current.title === 'New chat') {
          return title
        }
        updateSession(id, { title })
      } catch {
        // Session may have been deleted while the title model ran.
      }
      return title
    }
  )

  ipcMain.handle('chat:send', (_e, payload: ChatSendPayload) => enqueueTurn(payload))

  ipcMain.handle('chat:abort', () => {
    abortCurrentTurn()
  })

  ipcMain.handle('queue:getState', () => getQueueState())

  ipcMain.handle('queue:removeSession', (_e, sessionId: string) => {
    removeSessionTurns(sessionId)
    return getQueueState()
  })

  ipcMain.handle(
    'htmlPreview:create',
    (_e, payload: HtmlPreviewCreatePayload) => createHtmlPreview(payload)
  )
  ipcMain.handle('htmlPreview:destroy', (_e, id: string) => {
    destroyHtmlPreview(id)
  })

  ipcMain.handle('telegram:getStatus', () => getTelegramBotStatus())
  ipcMain.handle('telegram:setToken', async (_e, token: string | null) => {
    setTelegramBotToken(token)
    await restartTelegramBot()
    return getTelegramBotStatus()
  })
  ipcMain.handle('telegram:setEnabled', async (_e, enabled: boolean) => {
    setTelegramEnabled(enabled)
    if (enabled) await restartTelegramBot()
    else await stopTelegramBot()
    return getTelegramBotStatus()
  })
  ipcMain.handle('telegram:setAllowedUserIds', (_e, ids: number[]) => {
    return setTelegramAllowedUserIds(ids)
  })
  ipcMain.handle('telegram:setMirrorMode', (_e, mode: TelegramMirrorMode) => {
    return setTelegramMirrorMode(mode)
  })

  ipcMain.handle('schedules:list', () => listSchedules())

  ipcMain.handle(
    'schedules:create',
    (
      _e,
      input: Omit<TelegramSchedule, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastRunStatus' | 'lastRunError'>
    ) => {
      let sessionId = input.sessionId
      if (!sessionId) {
        if (input.delivery.mode === 'notification') {
          const session = createSession('desktop')
          session.title = `Schedule: ${input.name}`
          updateSession(session.id, { title: session.title })
          sessionId = session.id
          broadcastSessionsChanged()
        }
      }
      const schedule = createScheduleRecord({ ...input, sessionId })
      reloadScheduleRunner()
      broadcastSchedulesChanged()
      return schedule
    }
  )

  ipcMain.handle('schedules:update', (_e, schedule: TelegramSchedule) => {
    const updated: TelegramSchedule = {
      ...schedule,
      updatedAt: new Date().toISOString()
    }
    upsertSchedule(updated)
    reloadScheduleRunner()
    broadcastSchedulesChanged()
    return updated
  })

  ipcMain.handle('schedules:delete', (_e, id: string) => {
    deleteScheduleRecord(id)
    reloadScheduleRunner()
    broadcastSchedulesChanged()
    return listSchedules()
  })

  ipcMain.handle('schedules:runNow', async (_e, id: string) => {
    return runScheduleNow(id)
  })
}
