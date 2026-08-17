import { useMemo, useState } from 'react'
import type {
  CatalogInstallEnvHint,
  CatalogServer,
  McpServerConfig,
  McpToolInfo
} from '../../../shared/types'
import type { ServerWithStatus } from '../../../preload/index'
import {
  MCP_CATALOG,
  MCP_CATEGORIES,
  catalogToServerDraft,
  categoryLabel,
  isCatalogServerAdded
} from '../../../shared/mcp-catalog'
import { ServerForm } from './ServerForm'

type McpTab = 'mine' | 'catalog'

interface McpCatalogPageProps {
  servers: ServerWithStatus[]
  tools: McpToolInfo[]
  onRefreshServers: () => Promise<void> | void
}

const PAGE_SIZE = 24

export function McpCatalogPage({
  servers,
  tools,
  onRefreshServers
}: McpCatalogPageProps): React.JSX.Element {
  const [tab, setTab] = useState<McpTab>('mine')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [draft, setDraft] = useState<McpServerConfig | null>(null)
  const [draftMeta, setDraftMeta] = useState<{
    url?: string
    envHints?: CatalogInstallEnvHint[]
    hasInstall: boolean
  } | null>(null)
  const [editing, setEditing] = useState<McpServerConfig | null>(null)
  const [customAdd, setCustomAdd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return MCP_CATALOG.filter((entry) => {
      if (category && entry.category !== category) return false
      if (!q) return true
      const hay = [
        entry.name,
        entry.description,
        entry.language ?? '',
        ...(entry.tags ?? [])
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [query, category])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageItems = filtered.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  )

  const openCatalogAdd = (entry: CatalogServer): void => {
    setError(null)
    setEditing(null)
    setCustomAdd(false)
    setDraft(catalogToServerDraft(entry))
    setDraftMeta({
      url: entry.url,
      envHints: entry.install?.envHints,
      hasInstall: Boolean(entry.install)
    })
  }

  const openCustomAdd = (): void => {
    setError(null)
    setEditing(null)
    setDraft(null)
    setDraftMeta(null)
    setCustomAdd(true)
  }

  const openEdit = (server: McpServerConfig): void => {
    setError(null)
    setDraft(null)
    setDraftMeta(null)
    setCustomAdd(false)
    setEditing(server)
  }

  const closeForm = (): void => {
    setDraft(null)
    setDraftMeta(null)
    setEditing(null)
    setCustomAdd(false)
  }

  const handleSave = async (server: McpServerConfig): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await window.api.mcp.upsertServer(server)
      closeForm()
      await onRefreshServers()
      setTab('mine')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleConnect = async (id: string): Promise<void> => {
    setBusyId(id)
    setError(null)
    try {
      await window.api.mcp.connect(id)
      await onRefreshServers()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const handleDisconnect = async (id: string): Promise<void> => {
    setBusyId(id)
    setError(null)
    try {
      await window.api.mcp.disconnect(id)
      await onRefreshServers()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const handleRemove = async (id: string): Promise<void> => {
    setBusyId(id)
    setError(null)
    try {
      await window.api.mcp.removeServer(id)
      await onRefreshServers()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const formInitial = editing ?? draft
  const showForm = formInitial != null || customAdd

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="titlebar-drag titlebar-overlay-pad shrink-0 border-b border-[#243041] px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[#f0f4f8]">MCP Servers</h2>
            <p className="mt-0.5 text-sm text-[#8b9aab]">
              Manage connected servers and browse the catalog.
            </p>
          </div>
          <div className="titlebar-no-drag flex gap-1 rounded-lg border border-[#2a3a4d] bg-[#121820] p-0.5">
            <button
              type="button"
              onClick={() => setTab('mine')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                tab === 'mine'
                  ? 'bg-[#1a3050] text-[#9ec5f0]'
                  : 'text-[#8b9aab] hover:text-[#e7ecf1]'
              }`}
            >
              My servers
            </button>
            <button
              type="button"
              onClick={() => setTab('catalog')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                tab === 'catalog'
                  ? 'bg-[#1a3050] text-[#9ec5f0]'
                  : 'text-[#8b9aab] hover:text-[#e7ecf1]'
              }`}
            >
              Catalog
            </button>
          </div>
        </div>

        {tab === 'mine' ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[#6b7a8c]">
              {servers.length} server{servers.length === 1 ? '' : 's'} ·{' '}
              {tools.length} tool{tools.length === 1 ? '' : 's'}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onRefreshServers()}
                className="rounded-lg border border-[#2a3a4d] px-3 py-1.5 text-xs text-[#c5d0dc] hover:bg-[#1a2430]"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={openCustomAdd}
                className="rounded-lg bg-[#2d6cb5] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#3a7cc9]"
              >
                + Add custom
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setPage(1)
                }}
                placeholder="Search name, description, or tags…"
                className="w-full max-w-md rounded-lg border border-[#2a3a4d] bg-[#0f1419] px-3 py-2 text-sm outline-none placeholder:text-[#5a6a7c] focus:border-[#4a7ab0]"
              />
              <p className="text-xs text-[#6b7a8c]">
                {filtered.length} of {MCP_CATALOG.length} servers
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <CategoryChip
                active={category === null}
                label="All"
                onClick={() => {
                  setCategory(null)
                  setPage(1)
                }}
              />
              {MCP_CATEGORIES.map((id) => (
                <CategoryChip
                  key={id}
                  active={category === id}
                  label={categoryLabel(id)}
                  onClick={() => {
                    setCategory(id)
                    setPage(1)
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {error ? (
          <p className="mb-3 rounded-lg border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
            {error}
          </p>
        ) : null}

        {tab === 'mine' ? (
          <MyServersPanel
            servers={servers}
            tools={tools}
            busyId={busyId}
            onConnect={(id) => void handleConnect(id)}
            onDisconnect={(id) => void handleDisconnect(id)}
            onEdit={openEdit}
            onRemove={(id) => void handleRemove(id)}
            onBrowseCatalog={() => setTab('catalog')}
          />
        ) : (
          <CatalogPanel
            pageItems={pageItems}
            servers={servers}
            saving={saving}
            totalPages={totalPages}
            safePage={safePage}
            onPageChange={setPage}
            onAdd={openCatalogAdd}
          />
        )}
      </div>

      {showForm ? (
        <ServerForm
          initial={formInitial}
          docsUrl={draftMeta?.url}
          envHints={draftMeta?.envHints}
          hasInstallPreset={draftMeta?.hasInstall}
          saving={saving}
          onCancel={closeForm}
          onSave={(server) => void handleSave(server)}
        />
      ) : null}
    </main>
  )
}

function MyServersPanel({
  servers,
  tools,
  busyId,
  onConnect,
  onDisconnect,
  onEdit,
  onRemove,
  onBrowseCatalog
}: {
  servers: ServerWithStatus[]
  tools: McpToolInfo[]
  busyId: string | null
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onEdit: (server: McpServerConfig) => void
  onRemove: (id: string) => void
  onBrowseCatalog: () => void
}): React.JSX.Element {
  if (servers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <p className="text-sm text-[#8b9aab]">No servers configured yet.</p>
        <button
          type="button"
          onClick={onBrowseCatalog}
          className="rounded-lg bg-[#2d6cb5] px-3 py-2 text-xs font-medium text-white hover:bg-[#3a7cc9]"
        >
          Browse catalog
        </button>
      </div>
    )
  }

  return (
    <ul className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {servers.map((server) => {
        const serverTools = tools.filter((t) => t.serverId === server.id)
        return (
          <MyServerCard
            key={server.id}
            server={server}
            serverTools={serverTools}
            busy={busyId === server.id}
            onConnect={() => onConnect(server.id)}
            onDisconnect={() => onDisconnect(server.id)}
            onEdit={() => onEdit(server)}
            onRemove={() => onRemove(server.id)}
          />
        )
      })}
    </ul>
  )
}

function MyServerCard({
  server,
  serverTools,
  busy,
  onConnect,
  onDisconnect,
  onEdit,
  onRemove
}: {
  server: ServerWithStatus
  serverTools: McpToolInfo[]
  busy: boolean
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  const [toolsOpen, setToolsOpen] = useState(false)

  return (
    <li className="rounded-lg border border-[#2a3a4d] bg-[#121820] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[#f0f4f8]">{server.name}</h3>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                server.connected
                  ? 'bg-emerald-950/50 text-emerald-300'
                  : 'bg-[#1a2430] text-[#6b7a8c]'
              }`}
            >
              {server.connected ? 'Connected' : 'Offline'}
            </span>
            {server.connected ? (
              <span className="rounded bg-[#1a3050] px-1.5 py-0.5 text-[10px] text-[#9ec5f0]">
                {serverTools.length} tool
                {serverTools.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-[#6b7a8c]">
            {server.command} {server.args.join(' ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {server.connected ? (
            <button
              type="button"
              disabled={busy}
              onClick={onDisconnect}
              className="rounded border border-[#2a3a4d] px-2.5 py-1 text-[11px] text-[#c5d0dc] hover:bg-[#1a2430] disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onConnect}
              className="inline-flex items-center gap-1.5 rounded border border-[#3d6a9a] bg-[#1a3050] px-2.5 py-1 text-[11px] text-[#9ec5f0] hover:bg-[#234068] disabled:opacity-70"
            >
              {busy ? (
                <>
                  <span className="tool-spinner" />
                  Starting…
                </>
              ) : (
                'Connect'
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="rounded border border-[#2a3a4d] px-2.5 py-1 text-[11px] text-[#c5d0dc] hover:bg-[#1a2430] disabled:opacity-50"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="rounded border border-[#4a3030] px-2.5 py-1 text-[11px] text-rose-300 hover:bg-[#2a1818] disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      </div>

      {busy && !server.connected ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-[#8b9aab]">
          <span className="tool-spinner" />
          Starting the server — first run may download the package.
        </p>
      ) : server.connected ? (
        <div className="mt-3 border-t border-[#243041] pt-2">
          <button
            type="button"
            onClick={() => setToolsOpen((o) => !o)}
            className="flex w-full items-center justify-between rounded px-1 py-1.5 text-left hover:bg-[#1a2430]"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#6b7a8c]">
              Tools
              <span className="ml-1.5 font-normal normal-case tracking-normal text-[#8b9aab]">
                ({serverTools.length})
              </span>
            </span>
            <span className="font-mono text-[11px] text-[#6b7a8c]">
              {toolsOpen ? '−' : '+'}
            </span>
          </button>
          {toolsOpen ? (
            <div className="mt-1">
              {serverTools.length === 0 ? (
                <p className="px-1 text-xs text-[#6b7a8c]">
                  Connected, but no tools were advertised.
                </p>
              ) : (
                <ul className="space-y-2">
                  {serverTools.map((t) => (
                    <li
                      key={t.prefixedName}
                      className="rounded-md border border-[#243041] bg-[#0f1419] px-3 py-2"
                    >
                      <div className="font-mono text-xs text-[#9ec5f0]">
                        {t.name}
                      </div>
                      {t.description ? (
                        <p className="mt-1 text-xs leading-relaxed text-[#8b9aab]">
                          {t.description}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-[#6b7a8c]">
                          No description
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-[#6b7a8c]">
          Connect this server to load and inspect its tools.
        </p>
      )}
    </li>
  )
}

function CatalogPanel({
  pageItems,
  servers,
  saving,
  totalPages,
  safePage,
  onPageChange,
  onAdd
}: {
  pageItems: CatalogServer[]
  servers: Array<{ name: string }>
  saving: boolean
  totalPages: number
  safePage: number
  onPageChange: (page: number | ((p: number) => number)) => void
  onAdd: (entry: CatalogServer) => void
}): React.JSX.Element {
  return (
    <>
      {pageItems.length === 0 ? (
        <p className="py-12 text-center text-sm text-[#6b7a8c]">
          No servers match your filters.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {pageItems.map((entry) => {
            const added = isCatalogServerAdded(entry, servers)
            return (
              <li
                key={entry.id}
                className="flex flex-col rounded-lg border border-[#2a3a4d] bg-[#121820] p-4"
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold leading-snug text-[#f0f4f8]">
                    {entry.name}
                  </h3>
                  {added ? (
                    <span className="shrink-0 rounded bg-emerald-950/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                      Added
                    </span>
                  ) : entry.install ? (
                    <span className="shrink-0 rounded bg-[#1a3050] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#9ec5f0]">
                      One-click
                    </span>
                  ) : null}
                </div>
                <p className="mb-3 line-clamp-3 flex-1 text-xs leading-relaxed text-[#8b9aab]">
                  {entry.description}
                </p>
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <span className="rounded border border-[#2a3a4d] px-1.5 py-0.5 text-[10px] text-[#7a8a9c]">
                    {categoryLabel(entry.category)}
                  </span>
                  {entry.language ? (
                    <span className="rounded border border-[#2a3a4d] px-1.5 py-0.5 text-[10px] text-[#7a8a9c]">
                      {entry.language}
                    </span>
                  ) : null}
                  {entry.official ? (
                    <span className="rounded border border-[#2a3a4d] px-1.5 py-0.5 text-[10px] text-[#7a8a9c]">
                      Official
                    </span>
                  ) : null}
                </div>
                <div className="mt-auto flex items-center gap-2">
                  <button
                    type="button"
                    disabled={added || saving}
                    onClick={() => onAdd(entry)}
                    className="rounded bg-[#2d6cb5] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[#3a7cc9] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {added ? 'Already added' : 'Add'}
                  </button>
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded border border-[#2a3a4d] px-2.5 py-1.5 text-xs text-[#c5d0dc] hover:bg-[#1a2430]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Docs
                  </a>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {totalPages > 1 ? (
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            disabled={safePage <= 1}
            onClick={() => onPageChange((p) => Math.max(1, p - 1))}
            className="rounded border border-[#2a3a4d] px-3 py-1.5 text-xs text-[#c5d0dc] hover:bg-[#1a2430] disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-[#6b7a8c]">
            Page {safePage} of {totalPages}
          </span>
          <button
            type="button"
            disabled={safePage >= totalPages}
            onClick={() => onPageChange((p) => Math.min(totalPages, p + 1))}
            className="rounded border border-[#2a3a4d] px-3 py-1.5 text-xs text-[#c5d0dc] hover:bg-[#1a2430] disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}

      <footer className="mt-10 border-t border-[#243041] pt-4 pb-2 text-xs leading-relaxed text-[#6b7a8c]">
        Catalog adapted from{' '}
        <a
          href="https://github.com/mcpHQ/awesome-mcp-servers"
          target="_blank"
          rel="noreferrer"
          className="text-[#7aa4d4] hover:underline"
        >
          mcpHQ/awesome-mcp-servers
        </a>
        . Discover more on the{' '}
        <a
          href="https://registry.modelcontextprotocol.io"
          target="_blank"
          rel="noreferrer"
          className="text-[#7aa4d4] hover:underline"
        >
          official MCP Registry
        </a>{' '}
        and{' '}
        <a
          href="https://github.com/punkpeye/awesome-mcp-servers"
          target="_blank"
          rel="noreferrer"
          className="text-[#7aa4d4] hover:underline"
        >
          punkpeye/awesome-mcp-servers
        </a>
        . This app supports stdio servers (command/args/env) only — configure
        paths and API keys in the form, then connect from My servers.
      </footer>
    </>
  )
}

function CategoryChip({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
        active
          ? 'border-[#2d6cb5]/60 bg-[#1a3050] text-[#9ec5f0]'
          : 'border-[#2a3a4d] bg-[#0f1419] text-[#8b9aab] hover:bg-[#1a2430]'
      }`}
    >
      {label}
    </button>
  )
}
