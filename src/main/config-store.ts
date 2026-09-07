import { randomUUID } from 'crypto'
import Store from 'electron-store'
import type {
  AppConfig,
  ChatMessage,
  ChatSession,
  McpServerConfig,
  SessionOrigin,
  SessionsState,
  TelegramMirrorMode,
  TelegramSchedule,
  UiMessage
} from '../shared/types'

const DEFAULT_CONFIG: AppConfig = {
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  selectedModel: null,
  servers: [],
  showThinking: false,
  maxToolIterations: 30,
  telegramBotToken: null,
  telegramEnabled: false,
  telegramAllowedUserIds: [],
  telegramMirrorMode: 'full',
  defaultImageModel: null
}

interface StoreSchema extends AppConfig, SessionsState {
  skillEnabled: Record<string, boolean>
  schedules: TelegramSchedule[]
}

function sessionOrigin(session: ChatSession): SessionOrigin {
  return session.origin ?? 'desktop'
}

function normalizeSession(session: ChatSession): ChatSession {
  const origin = sessionOrigin(session)
  return session.origin === origin ? session : { ...session, origin }
}

function isDesktopSession(session: ChatSession): boolean {
  return sessionOrigin(session) === 'desktop'
}

function isTelegramSession(session: ChatSession): boolean {
  return sessionOrigin(session) === 'telegram'
}

const store = new Store<StoreSchema>({
  name: 'config',
  defaults: {
    ...DEFAULT_CONFIG,
    sessions: [],
    activeSessionId: null,
    telegramActiveSessionId: null,
    skillEnabled: {},
    schedules: []
  }
})

export function getConfig(): AppConfig {
  return {
    ollamaBaseUrl: store.get('ollamaBaseUrl', DEFAULT_CONFIG.ollamaBaseUrl),
    selectedModel: store.get('selectedModel', DEFAULT_CONFIG.selectedModel),
    servers: store.get('servers', DEFAULT_CONFIG.servers),
    showThinking: store.get('showThinking', DEFAULT_CONFIG.showThinking),
    maxToolIterations: clampMaxToolIterations(
      store.get('maxToolIterations', DEFAULT_CONFIG.maxToolIterations)
    ),
    telegramBotToken: store.get('telegramBotToken', DEFAULT_CONFIG.telegramBotToken),
    telegramEnabled: store.get('telegramEnabled', DEFAULT_CONFIG.telegramEnabled),
    telegramAllowedUserIds: store.get(
      'telegramAllowedUserIds',
      DEFAULT_CONFIG.telegramAllowedUserIds
    ),
    telegramMirrorMode: store.get(
      'telegramMirrorMode',
      DEFAULT_CONFIG.telegramMirrorMode
    ),
    defaultImageModel: store.get('defaultImageModel', DEFAULT_CONFIG.defaultImageModel)
  }
}

export function getOllamaBaseUrl(): string {
  return store.get('ollamaBaseUrl', DEFAULT_CONFIG.ollamaBaseUrl)
}

export function setOllamaBaseUrl(url: string): string {
  const trimmed = url.replace(/\/$/, '')
  store.set('ollamaBaseUrl', trimmed)
  return trimmed
}

export function getSelectedModel(): string | null {
  return store.get('selectedModel', null)
}

export function setSelectedModel(model: string | null): void {
  store.set('selectedModel', model)
}

export function getShowThinking(): boolean {
  return store.get('showThinking', DEFAULT_CONFIG.showThinking)
}

export function setShowThinking(enabled: boolean): boolean {
  store.set('showThinking', enabled)
  return enabled
}

export const MIN_MAX_TOOL_ITERATIONS = 8
export const MAX_MAX_TOOL_ITERATIONS = 100

export function clampMaxToolIterations(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONFIG.maxToolIterations
  return Math.min(MAX_MAX_TOOL_ITERATIONS, Math.max(MIN_MAX_TOOL_ITERATIONS, Math.round(value)))
}

export function getMaxToolIterations(): number {
  return clampMaxToolIterations(
    store.get('maxToolIterations', DEFAULT_CONFIG.maxToolIterations)
  )
}

export function setMaxToolIterations(value: number): number {
  const clamped = clampMaxToolIterations(value)
  store.set('maxToolIterations', clamped)
  return clamped
}

export function getTelegramBotToken(): string | null {
  return store.get('telegramBotToken', DEFAULT_CONFIG.telegramBotToken)
}

export function setTelegramBotToken(token: string | null): string | null {
  const trimmed = token?.trim() || null
  store.set('telegramBotToken', trimmed)
  return trimmed
}

export function getTelegramEnabled(): boolean {
  return store.get('telegramEnabled', DEFAULT_CONFIG.telegramEnabled)
}

export function setTelegramEnabled(enabled: boolean): boolean {
  store.set('telegramEnabled', enabled)
  return enabled
}

export function getTelegramAllowedUserIds(): number[] {
  return [...store.get('telegramAllowedUserIds', DEFAULT_CONFIG.telegramAllowedUserIds)]
}

export function setTelegramAllowedUserIds(ids: number[]): number[] {
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id)))]
  store.set('telegramAllowedUserIds', unique)
  return unique
}

export function getTelegramMirrorMode(): TelegramMirrorMode {
  return store.get('telegramMirrorMode', DEFAULT_CONFIG.telegramMirrorMode)
}

export function setTelegramMirrorMode(mode: TelegramMirrorMode): TelegramMirrorMode {
  store.set('telegramMirrorMode', mode)
  return mode
}

export function getDefaultImageModel(): string | null {
  return store.get('defaultImageModel', DEFAULT_CONFIG.defaultImageModel)
}

export function setDefaultImageModel(model: string | null): string | null {
  const value = model && model.trim() ? model.trim() : null
  store.set('defaultImageModel', value)
  return value
}

export function addTelegramAllowedUserId(id: number): number[] {
  const ids = getTelegramAllowedUserIds()
  if (!ids.includes(id)) ids.push(id)
  return setTelegramAllowedUserIds(ids)
}

export function listServers(): McpServerConfig[] {
  return store.get('servers', [])
}

export function upsertServer(server: McpServerConfig): McpServerConfig[] {
  const servers = listServers()
  const idx = servers.findIndex((s) => s.id === server.id)
  if (idx >= 0) {
    servers[idx] = server
  } else {
    servers.push(server)
  }
  store.set('servers', servers)
  return servers
}

export function setServerEnabled(id: string, enabled: boolean): McpServerConfig | null {
  const servers = listServers()
  const idx = servers.findIndex((s) => s.id === id)
  if (idx < 0) return null
  servers[idx] = { ...servers[idx], enabled }
  store.set('servers', servers)
  return servers[idx]
}

export function removeServer(id: string): McpServerConfig[] {
  const servers = listServers().filter((s) => s.id !== id)
  store.set('servers', servers)
  return servers
}

function stripHeavyHistory(history: ChatMessage[]): ChatMessage[] {
  // Avoid persisting multi-MB image payloads in electron-store
  return history.map((m) => {
    if (!m.images?.length) return m
    const { images: _images, ...rest } = m
    return rest
  })
}

function lastMessageCreatedAt(uiMessages: UiMessage[]): string | null {
  for (let i = uiMessages.length - 1; i >= 0; i--) {
    const createdAt = uiMessages[i]?.createdAt
    if (createdAt) return createdAt
  }
  return null
}

/** Session recency is last message time — not last open/flush. */
function sessionActivityAt(session: ChatSession): string {
  return lastMessageCreatedAt(session.uiMessages) ?? session.createdAt
}

function withActivityTimestamp(session: ChatSession): ChatSession {
  const updatedAt = sessionActivityAt(session)
  return session.updatedAt === updatedAt ? session : { ...session, updatedAt }
}

function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort(
    (a, b) =>
      new Date(sessionActivityAt(b)).getTime() -
      new Date(sessionActivityAt(a)).getTime()
  )
}

export function listSessions(): ChatSession[] {
  const sessions = store.get('sessions', []).map(normalizeSession).map(withActivityTimestamp)
  return sortSessions(sessions)
}

export function getActiveSessionId(): string | null {
  return store.get('activeSessionId', null)
}

export function getTelegramActiveSessionId(): string | null {
  return store.get('telegramActiveSessionId', null)
}

function ensureDesktopSessionExists(): void {
  const sessions = listSessions()
  if (sessions.some(isDesktopSession)) return

  const now = new Date().toISOString()
  const session: ChatSession = {
    id: randomUUID(),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    uiMessages: [],
    history: [],
    origin: 'desktop'
  }
  store.set('sessions', [session, ...sessions])
}

export function getSessionsState(): SessionsState {
  const sessions = listSessions()
  let activeSessionId = getActiveSessionId()
  let telegramActiveSessionId = getTelegramActiveSessionId()

  if (activeSessionId && !sessions.some((s) => s.id === activeSessionId)) {
    const desktopSessions = sessions.filter(isDesktopSession)
    activeSessionId = desktopSessions[0]?.id ?? sessions[0]?.id ?? null
    store.set('activeSessionId', activeSessionId)
  }

  const telegramSessions = sessions.filter(isTelegramSession)
  if (
    telegramActiveSessionId &&
    !telegramSessions.some((s) => s.id === telegramActiveSessionId)
  ) {
    telegramActiveSessionId = telegramSessions[0]?.id ?? null
    store.set('telegramActiveSessionId', telegramActiveSessionId)
  }

  return { sessions, activeSessionId, telegramActiveSessionId }
}

export function createSession(origin: SessionOrigin = 'desktop'): ChatSession {
  const now = new Date().toISOString()
  const session: ChatSession = {
    id: randomUUID(),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    uiMessages: [],
    history: [],
    origin
  }
  const sessions = [session, ...listSessions()]
  store.set('sessions', sessions)
  if (origin === 'telegram') {
    store.set('telegramActiveSessionId', session.id)
  } else {
    store.set('activeSessionId', session.id)
  }
  return session
}

export function setTelegramActiveSession(id: string): SessionsState {
  const session = listSessions().find((s) => s.id === id)
  if (!session || !isTelegramSession(session)) {
    throw new Error('Telegram session not found')
  }
  store.set('telegramActiveSessionId', id)
  return getSessionsState()
}

export function setActiveSession(id: string): SessionsState {
  const sessions = listSessions()
  if (!sessions.some((s) => s.id === id)) {
    throw new Error('Session not found')
  }
  store.set('activeSessionId', id)
  return getSessionsState()
}

export function updateSession(
  id: string,
  patch: Partial<Pick<ChatSession, 'title' | 'uiMessages' | 'history'>>
): ChatSession {
  const sessions = listSessions()
  const idx = sessions.findIndex((s) => s.id === id)
  if (idx < 0) throw new Error('Session not found')

  const nextMessages = patch.uiMessages ?? sessions[idx].uiMessages
  const updated: ChatSession = {
    ...sessions[idx],
    ...patch,
    history: patch.history
      ? stripHeavyHistory(patch.history)
      : sessions[idx].history,
    uiMessages: nextMessages,
    updatedAt: lastMessageCreatedAt(nextMessages) ?? sessions[idx].createdAt
  }
  sessions[idx] = updated
  store.set('sessions', sessions)
  return updated
}

export function deleteSession(id: string): SessionsState {
  let sessions = listSessions().filter((s) => s.id !== id)
  let activeSessionId = getActiveSessionId()
  let telegramActiveSessionId = getTelegramActiveSessionId()

  if (activeSessionId === id) {
    const desktopSessions = sessions.filter(isDesktopSession)
    activeSessionId = desktopSessions[0]?.id ?? null
  }

  if (telegramActiveSessionId === id) {
    const telegramSessions = sessions.filter(isTelegramSession)
    telegramActiveSessionId = telegramSessions[0]?.id ?? null
  }

  if (sessions.length === 0) {
    const now = new Date().toISOString()
    const session: ChatSession = {
      id: randomUUID(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      uiMessages: [],
      history: [],
      origin: 'desktop'
    }
    sessions = [session]
    activeSessionId = session.id
    telegramActiveSessionId = null
  }

  store.set('sessions', sessions)
  store.set('activeSessionId', activeSessionId)
  store.set('telegramActiveSessionId', telegramActiveSessionId)
  return getSessionsState()
}

export function getSkillEnabledMap(): Record<string, boolean> {
  return { ...store.get('skillEnabled', {}) }
}

export function setSkillEnabledFlag(id: string, enabled: boolean): void {
  const map = getSkillEnabledMap()
  map[id] = enabled
  store.set('skillEnabled', map)
}

export function removeSkillEnabledFlag(id: string): void {
  const map = getSkillEnabledMap()
  delete map[id]
  store.set('skillEnabled', map)
}

export function ensureActiveSession(): SessionsState {
  ensureDesktopSessionExists()
  const state = getSessionsState()
  if (!state.activeSessionId) {
    const desktopSessions = state.sessions.filter(isDesktopSession)
    const nextActive = desktopSessions[0]?.id ?? state.sessions[0]?.id ?? null
    if (nextActive) {
      store.set('activeSessionId', nextActive)
      return getSessionsState()
    }
    createSession('desktop')
    return getSessionsState()
  }
  return state
}

export function ensureTelegramActiveSession(): SessionsState {
  const state = getSessionsState()
  const telegramSessions = state.sessions.filter(isTelegramSession)
  if (
    state.telegramActiveSessionId &&
    telegramSessions.some((s) => s.id === state.telegramActiveSessionId)
  ) {
    return state
  }
  if (telegramSessions.length > 0) {
    store.set('telegramActiveSessionId', telegramSessions[0]!.id)
    return getSessionsState()
  }
  createSession('telegram')
  return getSessionsState()
}

export function listSchedules(): TelegramSchedule[] {
  return [...store.get('schedules', [])]
}

export function getSchedule(id: string): TelegramSchedule | null {
  return listSchedules().find((s) => s.id === id) ?? null
}

export function upsertSchedule(
  schedule: TelegramSchedule
): TelegramSchedule[] {
  const schedules = listSchedules()
  const idx = schedules.findIndex((s) => s.id === schedule.id)
  if (idx >= 0) {
    schedules[idx] = schedule
  } else {
    schedules.push(schedule)
  }
  store.set('schedules', schedules)
  return schedules
}

export function createScheduleRecord(
  input: Omit<TelegramSchedule, 'id' | 'createdAt' | 'updatedAt' | 'enabled'> & {
    enabled?: boolean
  }
): TelegramSchedule {
  const now = new Date().toISOString()
  const schedule: TelegramSchedule = {
    ...input,
    id: randomUUID(),
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now
  }
  upsertSchedule(schedule)
  return schedule
}

export function deleteScheduleRecord(id: string): TelegramSchedule[] {
  const schedules = listSchedules().filter((s) => s.id !== id)
  store.set('schedules', schedules)
  return schedules
}

export function patchScheduleRun(
  id: string,
  patch: Pick<TelegramSchedule, 'lastRunAt' | 'lastRunStatus' | 'lastRunError'>
): TelegramSchedule | null {
  const schedule = getSchedule(id)
  if (!schedule) return null
  const updated: TelegramSchedule = {
    ...schedule,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  upsertSchedule(updated)
  return updated
}
