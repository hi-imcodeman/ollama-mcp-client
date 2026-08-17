import type { ChatSession } from '../../../shared/types'
import appIcon from '../assets/icon-128.png'

interface SidebarProps {
  sessions: ChatSession[]
  activeSessionId: string | null
  view: 'chat' | 'models' | 'mcp'
  onNewSession: () => void
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onOpenModels: () => void
  onOpenMcp: () => void
  onOpenSettings: () => void
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return new Date(iso).toLocaleDateString()
}

export function Sidebar({
  sessions,
  activeSessionId,
  view,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onOpenModels,
  onOpenMcp,
  onOpenSettings
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[#243041] bg-[#121820]">
      <div className="titlebar-drag titlebar-traffic-pad border-b border-[#243041] px-4 pb-4 pt-3">
        <div className="flex items-center gap-3">
          <img
            src={appIcon}
            alt=""
            width={44}
            height={44}
            draggable={false}
            className="h-11 w-11 shrink-0 rounded-[10px] shadow-sm shadow-black/30"
          />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight text-[#f0f4f8]">
              Ollama MCP
            </h1>
            <p className="mt-0.5 truncate text-xs text-[#8b9aab]">
              Local models + MCP tools
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onNewSession}
          className="titlebar-no-drag mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#2d6cb5] px-3 py-2 text-sm font-medium text-white hover:bg-[#3a7cc9]"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M8 3.5v9M3.5 8h9"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          New chat
        </button>
        <button
          type="button"
          onClick={onOpenModels}
          className={`titlebar-no-drag mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
            view === 'models'
              ? 'border-[#2d6cb5]/50 bg-[#1a3050] text-[#9ec5f0]'
              : 'border-[#2a3a4d] bg-[#0f1419] text-[#e7ecf1] hover:bg-[#1a2430]'
          }`}
        >
          Models
        </button>
        <button
          type="button"
          onClick={onOpenMcp}
          className={`titlebar-no-drag mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
            view === 'mcp'
              ? 'border-[#2d6cb5]/50 bg-[#1a3050] text-[#9ec5f0]'
              : 'border-[#2a3a4d] bg-[#0f1419] text-[#e7ecf1] hover:bg-[#1a2430]'
          }`}
        >
          MCP Servers
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <h2 className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-[#6b7a8c]">
          Sessions
        </h2>
        <ul className="space-y-0.5">
          {sessions.length === 0 && (
            <li className="px-2 py-3 text-xs text-[#6b7a8c]">No chats yet.</li>
          )}
          {sessions.map((session) => {
            const active = session.id === activeSessionId
            return (
              <li key={session.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelectSession(session.id)}
                  className={`flex w-full flex-col gap-1 rounded-lg px-2.5 py-2.5 text-left transition ${
                    active
                      ? 'bg-[#1a3050] text-[#9ec5f0] ring-1 ring-[#2d6cb5]/40'
                      : 'text-[#e7ecf1] hover:bg-[#1a2430]'
                  }`}
                >
                  <span className="line-clamp-2 pr-6 text-sm font-medium leading-snug">
                    {session.title || 'New chat'}
                  </span>
                  <span
                    className={`text-[10px] ${active ? 'text-[#7aa4d4]' : 'text-[#6b7a8c]'}`}
                  >
                    {formatRelativeTime(
                      session.uiMessages.at(-1)?.createdAt ??
                        session.updatedAt ??
                        session.createdAt
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  title="Delete chat"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteSession(session.id)
                  }}
                  className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded text-[#8b9aab] hover:bg-[#2a1818] hover:text-rose-300 group-hover:flex"
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="border-t border-[#243041] p-3">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#2a3a4d] bg-[#0f1419] px-3 py-2 text-sm text-[#e7ecf1] hover:bg-[#1a2430]"
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
          Settings
        </button>
      </div>
    </aside>
  )
}
