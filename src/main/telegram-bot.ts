import { Input, Telegraf } from 'telegraf'
import type { Context } from 'telegraf'
import type { TelegramStatus } from '../shared/types'
import {
  addTelegramAllowedUserId,
  createSession,
  deleteSession,
  getSchedule,
  getSessionsState,
  getTelegramActiveSessionId,
  getSelectedModel,
  getTelegramAllowedUserIds,
  getTelegramBotToken,
  getTelegramEnabled,
  listSchedules,
  setTelegramActiveSession,
  upsertSchedule
} from './config-store'
import { broadcastSessionsChanged } from './sessions-broadcast'
import { reloadScheduleRunner, runScheduleNow } from './schedule-runner'
import { broadcastSchedulesChanged } from './schedules-broadcast'
import {
  chunkTelegramHtml,
  chunkTelegramText,
  markdownToTelegramHtml
} from './telegram-format'
import {
  resetTelegramMirrorState,
  startTelegramMirror,
  type TelegramSendFns
} from './telegram-mirror'
import { runTelegramTurn } from './telegram-turn'
import { removeSessionTurns } from './chat-queue'
import { clearLatestGeneratedImage } from './agent'

let bot: Telegraf | null = null
let running = false
let lastError: string | undefined
let stopMirror: (() => void) | null = null
let botUsername: string | undefined
const unauthorizedNotified = new Set<number>()

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private'
}

function createSendFns(telegram: Telegraf['telegram']): TelegramSendFns {
  return {
    sendText: async (userId, text) => {
      await telegram.sendMessage(userId, text)
    },
    sendMarkdownChunks: async (userId, markdown) => {
      const html = markdownToTelegramHtml(markdown)
      const chunks = chunkTelegramHtml(html)
      const plainChunks = chunkTelegramText(markdown)
      for (let i = 0; i < chunks.length; i++) {
        const htmlChunk = chunks[i]!
        try {
          await telegram.sendMessage(userId, htmlChunk, { parse_mode: 'HTML' })
        } catch {
          await telegram.sendMessage(userId, plainChunks[i] ?? htmlChunk)
        }
      }
    },
    sendStreamMessage: async (userId, text) => {
      const msg = await telegram.sendMessage(userId, text)
      return msg.message_id
    },
    editText: async (userId, messageId, text) => {
      try {
        await telegram.editMessageText(userId, messageId, undefined, text)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!message.includes('message is not modified')) {
          console.error('[telegram] editMessageText failed:', message)
          throw err
        }
      }
    },
    sendPhoto: async (userId, base64, caption) => {
      await telegram.sendPhoto(userId, Input.fromBuffer(Buffer.from(base64, 'base64')), {
        caption
      })
    },
    sendTyping: async (userId) => {
      await telegram.sendChatAction(userId, 'typing')
    }
  }
}

function telegramSessions() {
  return getSessionsState().sessions.filter((s) => (s.origin ?? 'desktop') === 'telegram')
}

function resolveSessionArg(arg: string): string | null {
  const trimmed = arg.trim()
  if (!trimmed) return null

  const sessions = telegramSessions()
  const index = Number.parseInt(trimmed, 10)
  if (Number.isFinite(index) && index >= 1 && index <= sessions.length) {
    return sessions[index - 1]!.id
  }

  const lower = trimmed.toLowerCase()
  const match = sessions.find((s) => s.title.toLowerCase().includes(lower))
  return match?.id ?? null
}

function resolveScheduleArg(arg: string): string | null {
  const trimmed = arg.trim()
  if (!trimmed) return null

  const schedules = listSchedules()
  const index = Number.parseInt(trimmed, 10)
  if (Number.isFinite(index) && index >= 1 && index <= schedules.length) {
    return schedules[index - 1]!.id
  }

  const lower = trimmed.toLowerCase()
  const match = schedules.find((s) => s.name.toLowerCase().includes(lower))
  return match?.id ?? null
}

function activeSessionTitle(): string {
  const state = getSessionsState()
  const activeId = getTelegramActiveSessionId() ?? state.telegramActiveSessionId
  const session = state.sessions.find((s) => s.id === activeId)
  return session?.title ?? 'No active session'
}

async function authMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
  if (!isPrivateChat(ctx)) return

  const userId = ctx.from?.id
  if (userId == null) return

  let allowlist = getTelegramAllowedUserIds()

  // First contact: claim owner when allowlist is still empty (/start or any message).
  if (allowlist.length === 0) {
    allowlist = addTelegramAllowedUserId(userId)
    unauthorizedNotified.delete(userId)
    return next()
  }

  if (!allowlist.includes(userId)) {
    if (!unauthorizedNotified.has(userId)) {
      unauthorizedNotified.add(userId)
      await ctx.reply(
        `Unauthorized. Your Telegram user ID is ${userId}.\n\n` +
          'Ask the bot owner to add this ID in the desktop app: Settings → Telegram → Allowed user IDs.\n' +
          'Or send /start if you are setting up this bot for the first time.'
      )
    }
    return
  }

  return next()
}

function registerHandlers(instance: Telegraf): void {
  instance.command('start', async (ctx) => {
    const userId = ctx.from?.id
    if (userId == null) return
    await ctx.reply(
      `Welcome to Ollama MCP.\n\nYour Telegram user ID: ${userId}\n\nSend a message to chat, or use /help for commands. Telegram sessions are separate from desktop chats.`
    )
  })

  instance.command('help', async (ctx) => {
    await ctx.reply(
      [
        'Commands:',
        '/start — welcome and your user ID',
        '/help — this message',
        '/new — create a new Telegram chat session',
        '/sessions — list Telegram sessions (tap to switch)',
        '/switch <n|title> — switch Telegram session',
        '/delete <n|title> — delete a Telegram session',
        '/current — show active session info',
        '/schedule list — list scheduled tasks',
        '/schedule run <n|name> — run a schedule now',
        '/schedule pause <n|name> — pause a schedule',
        '/schedule resume <n|name> — resume a schedule',
        '',
        `Current session: ${activeSessionTitle()}`
      ].join('\n')
    )
  })

  instance.command('new', async (ctx) => {
    const session = createSession('telegram')
    broadcastSessionsChanged()
    await ctx.reply(`Created new Telegram session: ${session.title}`)
  })

  instance.command('sessions', async (ctx) => {
    const state = getSessionsState()
    const sessions = telegramSessions().slice(0, 10)
    if (sessions.length === 0) {
      await ctx.reply('No Telegram sessions yet. Use /new to create one.')
      return
    }

    const activeId = getTelegramActiveSessionId() ?? state.telegramActiveSessionId
    const lines = sessions.map((s, i) => {
      const marker = s.id === activeId ? ' •' : ''
      return `${i + 1}. ${s.title}${marker}`
    })

    const keyboard = sessions.map((s) => [
      { text: s.title, callback_data: `switch:${s.id}` }
    ])

    await ctx.reply(lines.join('\n'), {
      reply_markup: { inline_keyboard: keyboard }
    })
  })

  instance.command('switch', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
    const arg = text.replace(/^\/switch(@\w+)?\s*/i, '').trim()
    if (!arg) {
      await ctx.reply('Usage: /switch <number|title>')
      return
    }

    const sessionId = resolveSessionArg(arg)
    if (!sessionId) {
      await ctx.reply('Session not found.')
      return
    }

    setTelegramActiveSession(sessionId)
    broadcastSessionsChanged()
    const title = getSessionsState().sessions.find((s) => s.id === sessionId)?.title
    await ctx.reply(`Switched to: ${title ?? sessionId}`)
  })

  instance.command('delete', async (ctx) => {
    const sessions = telegramSessions()
    if (sessions.length === 0) {
      await ctx.reply('No Telegram sessions to delete.')
      return
    }

    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
    const arg = text.replace(/^\/delete(@\w+)?\s*/i, '').trim()
    if (!arg) {
      await ctx.reply('Usage: /delete <number|title>')
      return
    }

    const sessionId = resolveSessionArg(arg)
    if (!sessionId) {
      await ctx.reply('Session not found.')
      return
    }

    const title = sessions.find((s) => s.id === sessionId)?.title ?? sessionId
    await ctx.reply(`Delete session "${title}"?`, {
      reply_markup: {
        inline_keyboard: [[{ text: 'Confirm delete', callback_data: `delete:${sessionId}` }]]
      }
    })
  })

  instance.command('current', async (ctx) => {
    const state = getSessionsState()
    const activeId = getTelegramActiveSessionId() ?? state.telegramActiveSessionId
    const session = state.sessions.find((s) => s.id === activeId)
    if (!session) {
      await ctx.reply('No active Telegram session.')
      return
    }

    const model = getSelectedModel()
    await ctx.reply(
      [
        `Session: ${session.title}`,
        `Messages: ${session.uiMessages.length}`,
        `Model: ${model ?? '(not selected — choose one in the desktop app)'}`
      ].join('\n')
    )
  })

  instance.command('schedule', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
    const body = text.replace(/^\/schedule(@\w+)?\s*/i, '').trim()
    const [sub, ...rest] = body.split(/\s+/)
    const arg = rest.join(' ').trim()
    const action = (sub || 'list').toLowerCase()

    if (action === 'list') {
      const schedules = listSchedules()
      if (schedules.length === 0) {
        await ctx.reply('No schedules. Create them in the desktop app: Schedules page.')
        return
      }
      const lines = schedules.map((s, i) => {
        const status = s.enabled ? 'on' : 'paused'
        const last = s.lastRunAt
          ? ` · last ${new Date(s.lastRunAt).toLocaleString()}`
          : ''
        return `${i + 1}. ${s.name} (${status})${last}`
      })
      await ctx.reply(lines.join('\n'))
      return
    }

    if (!arg) {
      await ctx.reply('Usage: /schedule run|pause|resume <number|name>')
      return
    }

    const scheduleId = resolveScheduleArg(arg)
    if (!scheduleId) {
      await ctx.reply('Schedule not found.')
      return
    }

    const schedule = getSchedule(scheduleId)
    if (!schedule) {
      await ctx.reply('Schedule not found.')
      return
    }

    if (action === 'run') {
      const result = await runScheduleNow(scheduleId)
      if (!result.ok) {
        await ctx.reply(result.error ?? 'Run failed.')
        return
      }
      await ctx.reply(`Started: ${schedule.name}`)
      return
    }

    if (action === 'pause') {
      if (!schedule.enabled) {
        await ctx.reply(`Already paused: ${schedule.name}`)
        return
      }
      upsertSchedule({
        ...schedule,
        enabled: false,
        updatedAt: new Date().toISOString()
      })
      reloadScheduleRunner()
      broadcastSchedulesChanged()
      await ctx.reply(`Paused: ${schedule.name}`)
      return
    }

    if (action === 'resume') {
      if (schedule.enabled) {
        await ctx.reply(`Already running: ${schedule.name}`)
        return
      }
      upsertSchedule({
        ...schedule,
        enabled: true,
        updatedAt: new Date().toISOString()
      })
      reloadScheduleRunner()
      broadcastSchedulesChanged()
      await ctx.reply(`Resumed: ${schedule.name}`)
      return
    }

    await ctx.reply('Usage: /schedule list|run|pause|resume …')
  })

  instance.command('mirror', async (ctx) => {
    await ctx.reply(
      'Live status is always on: one line updates for thinking, tool calls, and writing, then the final reply.'
    )
  })

  instance.on('text', async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith('/')) return

    const userId = ctx.from?.id
    if (userId != null) {
      void ctx.sendChatAction('typing')
    }

    const result = await runTelegramTurn(text)
    if (!result.ok) {
      await ctx.reply(result.error)
    }
  })

  instance.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined
    if (!data) {
      await ctx.answerCbQuery()
      return
    }

    if (data.startsWith('switch:')) {
      const sessionId = data.slice('switch:'.length)
      try {
        setTelegramActiveSession(sessionId)
        broadcastSessionsChanged()
        const title = getSessionsState().sessions.find((s) => s.id === sessionId)?.title
        await ctx.answerCbQuery(`Switched to ${title ?? sessionId}`)
      } catch {
        await ctx.answerCbQuery('Session not found')
      }
      return
    }

    if (data.startsWith('delete:')) {
      const sessionId = data.slice('delete:'.length)
      const session = getSessionsState().sessions.find((s) => s.id === sessionId)
      if (!session || (session.origin ?? 'desktop') !== 'telegram') {
        await ctx.answerCbQuery('Telegram session not found')
        return
      }
      try {
        removeSessionTurns(sessionId)
        clearLatestGeneratedImage(sessionId)
        deleteSession(sessionId)
        broadcastSessionsChanged()
        await ctx.answerCbQuery('Session deleted')
      } catch {
        await ctx.answerCbQuery('Could not delete session')
      }
      return
    }

    await ctx.answerCbQuery()
  })
}

export function getTelegramBotStatus(): TelegramStatus {
  return { running, error: lastError, botUsername }
}

export async function startTelegramBot(): Promise<void> {
  const token = getTelegramBotToken()
  const enabled = getTelegramEnabled()
  if (!enabled || !token) return

  try {
    const instance = new Telegraf(token)
    instance.use(authMiddleware)
    registerHandlers(instance)

    stopMirror = startTelegramMirror(createSendFns(instance.telegram))

    const me = await instance.telegram.getMe()
    bot = instance
    running = true
    lastError = undefined
    botUsername = me.username

    // launch() runs until stop() — must not block app startup
    void instance.launch().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err)
      running = false
      bot = null
      stopMirror?.()
      stopMirror = null
      resetTelegramMirrorState()
      console.error('[telegram] bot stopped:', lastError)
    })
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    running = false
    bot = null
    stopMirror?.()
    stopMirror = null
    resetTelegramMirrorState()
  }
}

export async function stopTelegramBot(): Promise<void> {
  stopMirror?.()
  stopMirror = null

  if (bot) {
    try {
      bot.stop('shutdown')
    } catch {
      // ignore stop errors during shutdown
    }
  }

  bot = null
  running = false
  botUsername = undefined
  resetTelegramMirrorState()
}

export async function restartTelegramBot(): Promise<void> {
  await stopTelegramBot()
  await startTelegramBot()
}
