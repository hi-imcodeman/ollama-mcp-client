import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  LibraryCapability,
  LibraryModelDetail,
  LibraryModelSummary,
  OllamaModel,
  OllamaModelDetails,
  PullProgressEvent
} from '../../../shared/types'
import { MarkdownContent } from './MarkdownContent'

type ModelsTab = 'installed' | 'library'
type LibrarySort = 'popular' | 'newest' | 'smallest' | 'largest'
type InstalledSort = 'name' | 'smallest' | 'largest'

interface ModelsPageProps {
  models: OllamaModel[]
  ollamaOk: boolean
  selectedModel: string | null
  active?: boolean
  onRefreshModels: () => Promise<void>
  onUseInChat: (model: string) => void
}

const PAGE_SIZE = 12

const LIBRARY_FILTERS: Array<{ id: LibraryCapability | null; label: string }> = [
  { id: null, label: 'All' },
  { id: 'tools', label: 'Tools' },
  { id: 'vision', label: 'Vision' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'embedding', label: 'Embedding' },
  { id: 'cloud', label: 'Cloud' }
]

function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function diskLabelToBytes(label: string): number {
  const m = label.replace(/\s/g, '').match(/^([\d.]+)([KMGT]B)$/i)
  if (!m) return Number.POSITIVE_INFINITY
  const n = parseFloat(m[1])
  const unit = m[2].toUpperCase()
  const mul: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
  }
  return n * (mul[unit] ?? 1)
}

function smallestDiskLabel(sizes: Array<string | undefined>): string | undefined {
  const labels = sizes.filter((s): s is string => Boolean(s))
  if (!labels.length) return undefined
  return [...labels].sort((a, b) => diskLabelToBytes(a) - diskLabelToBytes(b))[0]
}

function formatDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function TrashIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        d="M3.5 4.5h9M6.5 4.5V3.25A.75.75 0 0 1 7.25 2.5h1.5a.75.75 0 0 1 .75.75V4.5m1.5 0v8.25a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4.5m2 2.5v4.5m2-4.5v4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function localBaseName(name: string): string {
  return name.split(':')[0] ?? name
}

function isInstalledFamily(local: OllamaModel[], libraryName: string): boolean {
  return local.some((m) => localBaseName(m.name) === libraryName)
}

function isTagInstalled(local: OllamaModel[], tagName: string): boolean {
  const base = tagName.includes(':') ? tagName : `${tagName}:latest`
  return local.some(
    (m) => m.name === tagName || m.name === base || `${m.name}:latest` === base
  )
}

function isCloudModelRef(name: string): boolean {
  const tag = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : ''
  return (
    tag === 'cloud' ||
    tag.endsWith('-cloud') ||
    /(^|[/])cloud$/i.test(name)
  )
}

function formatPullError(raw: string, model: string): string {
  const lower = raw.toLowerCase()
  if (isCloudModelRef(model) || lower.includes('file does not exist')) {
    if (isCloudModelRef(model)) {
      return (
        `"${model}" is a cloud tag and cannot be downloaded as a local model. ` +
        'Open the model details and pull a local tag (one with a size), or use Ollama Cloud / sign-in for cloud models.'
      )
    }
    return (
      `Could not find "${model}" in the registry (manifest missing). ` +
      'Open details and pick a specific local tag, or try another model.'
    )
  }
  return raw
}

/** Prefer :latest with a size, else the smallest local (non-cloud) tag. */
function pickLocalPullTag(
  modelName: string,
  tags: Array<{ name: string; size?: string }>
): string | null {
  const local = tags.filter(
    (t) => !isCloudModelRef(t.name) && Boolean(t.size)
  )
  if (local.length === 0) {
    // No sized tags — try explicit :latest if present and not cloud
    const latest = tags.find(
      (t) =>
        (t.name === `${modelName}:latest` || t.name.endsWith(':latest')) &&
        !isCloudModelRef(t.name)
    )
    return latest?.name ?? null
  }
  const latestSized = local.find(
    (t) => t.name === `${modelName}:latest` || t.name.endsWith(':latest')
  )
  if (latestSized) return latestSized.name
  const sorted = [...local].sort(
    (a, b) => diskLabelToBytes(a.size!) - diskLabelToBytes(b.size!)
  )
  return sorted[0]?.name ?? null
}

export function ModelsPage({
  models,
  ollamaOk,
  selectedModel,
  active = true,
  onRefreshModels,
  onUseInChat
}: ModelsPageProps): React.JSX.Element {
  const [tab, setTab] = useState<ModelsTab>('installed')
  const [installedQuery, setInstalledQuery] = useState('')
  const [installedCap, setInstalledCap] = useState<string | null>(null)
  const [installedSort, setInstalledSort] = useState<InstalledSort>('name')
  const [installedPage, setInstalledPage] = useState(1)

  const [libraryQuery, setLibraryQuery] = useState('')
  const [libraryDraft, setLibraryDraft] = useState('')
  const [libraryCap, setLibraryCap] = useState<LibraryCapability | null>(null)
  const [libraryOrder, setLibraryOrder] = useState<LibrarySort>('popular')
  const [libraryPage, setLibraryPage] = useState(0)
  const [libraryModels, setLibraryModels] = useState<LibraryModelSummary[]>([])
  const [libraryHasMore, setLibraryHasMore] = useState(false)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryLoadingMore, setLibraryLoadingMore] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const libraryScrollRef = useRef<HTMLDivElement>(null)
  const librarySentinelRef = useRef<HTMLDivElement>(null)
  const libraryRequestIdRef = useRef(0)

  const [detailKind, setDetailKind] = useState<'local' | 'remote' | null>(null)
  const [detailName, setDetailName] = useState<string | null>(null)
  const [localDetail, setLocalDetail] = useState<OllamaModelDetails | null>(null)
  const [remoteDetail, setRemoteDetail] = useState<LibraryModelDetail | null>(null)
  const [readmeMd, setReadmeMd] = useState<string | null>(null)
  const [readmeLoading, setReadmeLoading] = useState(false)
  const [readmeMissing, setReadmeMissing] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const detailRequestRef = useRef(0)

  const [pulling, setPulling] = useState<string | null>(null)
  const [pullProgress, setPullProgress] = useState<PullProgressEvent | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyDelete, setBusyDelete] = useState<string | null>(null)

  useEffect(() => {
    const subscribe = window.api.ollama.onPullProgress
    if (typeof subscribe !== 'function') {
      console.warn(
        '[models] onPullProgress unavailable — restart the Electron app to reload preload'
      )
      return
    }
    return subscribe((event) => {
      setPullProgress(event)
      if (event.done) {
        setPulling(null)
        void onRefreshModels()
      }
    })
  }, [onRefreshModels])

  const sortLibraryModels = useCallback(
    (list: LibraryModelSummary[]): LibraryModelSummary[] => {
      if (libraryOrder !== 'smallest' && libraryOrder !== 'largest') return list
      const dir = libraryOrder === 'smallest' ? 1 : -1
      return [...list].sort((a, b) => {
        const aUnknown = !a.minSize
        const bUnknown = !b.minSize
        if (aUnknown && bUnknown) return a.name.localeCompare(b.name)
        if (aUnknown) return 1
        if (bUnknown) return -1
        const aBytes = diskLabelToBytes(a.minSize!)
        const bBytes = diskLabelToBytes(b.minSize!)
        if (aBytes === bBytes) return a.name.localeCompare(b.name)
        return (aBytes - bBytes) * dir
      })
    },
    [libraryOrder]
  )

  const loadLibraryPage = useCallback(
    async (page: number, mode: 'replace' | 'append'): Promise<void> => {
      const requestId = ++libraryRequestIdRef.current
      if (mode === 'replace') {
        setLibraryLoading(true)
        setLibraryError(null)
      } else {
        setLibraryLoadingMore(true)
      }
      try {
        const apiOrder = libraryOrder === 'newest' ? 'newest' : 'popular'
        const result = await window.api.ollama.searchLibrary({
          q: libraryQuery || undefined,
          category: libraryCap,
          order: apiOrder,
          page
        })
        if (requestId !== libraryRequestIdRef.current) return

        setLibraryModels((prev) => {
          const merged =
            mode === 'append'
              ? (() => {
                  const seen = new Set(prev.map((m) => m.name))
                  const next = [...prev]
                  for (const m of result.models) {
                    if (seen.has(m.name)) continue
                    seen.add(m.name)
                    next.push(m)
                  }
                  return next
                })()
              : result.models
          return sortLibraryModels(merged)
        })
        setLibraryHasMore(result.hasMore)
        setLibraryPage(result.page)
      } catch (err) {
        if (requestId !== libraryRequestIdRef.current) return
        if (mode === 'replace') {
          setLibraryModels([])
          setLibraryHasMore(false)
        }
        setLibraryError(err instanceof Error ? err.message : String(err))
      } finally {
        if (requestId === libraryRequestIdRef.current) {
          setLibraryLoading(false)
          setLibraryLoadingMore(false)
        }
      }
    },
    [libraryQuery, libraryCap, libraryOrder, sortLibraryModels]
  )

  useEffect(() => {
    if (tab !== 'library') return
    libraryRequestIdRef.current += 1
    setLibraryModels([])
    setLibraryPage(0)
    setLibraryHasMore(true)
    setLibraryError(null)
    void loadLibraryPage(1, 'replace')
  }, [tab, libraryQuery, libraryCap, libraryOrder, loadLibraryPage])

  useLayoutEffect(() => {
    if (!active || tab !== 'library') return
    const el = libraryScrollRef.current
    if (!el) return
    el.scrollTop = 0
  }, [active, tab, libraryQuery, libraryCap, libraryOrder])

  useEffect(() => {
    if (tab !== 'library') return
    const root = libraryScrollRef.current
    const sentinel = librarySentinelRef.current
    if (!root || !sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        if (!libraryHasMore || libraryLoading || libraryLoadingMore) return
        if (libraryPage < 1) return
        void loadLibraryPage(libraryPage + 1, 'append')
      },
      { root, rootMargin: '240px 0px', threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    tab,
    libraryHasMore,
    libraryLoading,
    libraryLoadingMore,
    libraryPage,
    loadLibraryPage,
    libraryModels.length
  ])

  const filteredInstalled = useMemo(() => {
    const q = installedQuery.trim().toLowerCase()
    const list = models.filter((m) => {
      if (q && !m.name.toLowerCase().includes(q) && !(m.family ?? '').toLowerCase().includes(q)) {
        return false
      }
      if (installedCap) {
        const caps = (m.capabilities ?? []).map((c) => c.toLowerCase())
        const tags = m.tags.map((t) => t.toLowerCase())
        if (!caps.includes(installedCap) && !tags.includes(installedCap)) return false
      }
      return true
    })
    if (installedSort === 'name') {
      return [...list].sort((a, b) => a.name.localeCompare(b.name))
    }
    const dir = installedSort === 'smallest' ? 1 : -1
    return [...list].sort((a, b) => {
      if (a.size === b.size) return a.name.localeCompare(b.name)
      return (a.size - b.size) * dir
    })
  }, [models, installedQuery, installedCap, installedSort])

  const installedPages = Math.max(1, Math.ceil(filteredInstalled.length / PAGE_SIZE))
  const installedSlice = filteredInstalled.slice(
    (installedPage - 1) * PAGE_SIZE,
    installedPage * PAGE_SIZE
  )

  useEffect(() => {
    setInstalledPage(1)
  }, [installedQuery, installedCap, installedSort])

  const openLocalDetail = async (name: string): Promise<void> => {
    const requestId = ++detailRequestRef.current
    setDetailKind('local')
    setDetailName(name)
    setRemoteDetail(null)
    setReadmeMd(null)
    setReadmeMissing(false)
    setReadmeLoading(true)
    setDetailLoading(true)
    setDetailError(null)
    try {
      const [detail, readme] = await Promise.all([
        window.api.ollama.showModel(name),
        window.api.ollama.getLibraryReadme(localBaseName(name)).catch(() => undefined)
      ])
      if (requestId !== detailRequestRef.current) return
      setLocalDetail(detail)
      setReadmeMd(readme ?? null)
      setReadmeMissing(!readme)
    } catch (err) {
      if (requestId !== detailRequestRef.current) return
      setLocalDetail(null)
      setDetailError(err instanceof Error ? err.message : String(err))
      setReadmeMissing(true)
    } finally {
      if (requestId === detailRequestRef.current) {
        setDetailLoading(false)
        setReadmeLoading(false)
      }
    }
  }

  const openRemoteDetail = async (name: string): Promise<void> => {
    const requestId = ++detailRequestRef.current
    setDetailKind('remote')
    setDetailName(name)
    setLocalDetail(null)
    setReadmeMd(null)
    setReadmeMissing(false)
    setReadmeLoading(true)
    setDetailLoading(true)
    setDetailError(null)
    try {
      const detail = await window.api.ollama.getLibraryModel(name)
      if (requestId !== detailRequestRef.current) return
      setRemoteDetail(detail)
      setReadmeMd(detail.readme ?? null)
      setReadmeMissing(!detail.readme)
    } catch (err) {
      if (requestId !== detailRequestRef.current) return
      setRemoteDetail(null)
      setDetailError(err instanceof Error ? err.message : String(err))
      setReadmeMissing(true)
    } finally {
      if (requestId === detailRequestRef.current) {
        setDetailLoading(false)
        setReadmeLoading(false)
      }
    }
  }

  const closeDetail = (): void => {
    detailRequestRef.current += 1
    setDetailKind(null)
    setDetailName(null)
    setLocalDetail(null)
    setRemoteDetail(null)
    setReadmeMd(null)
    setReadmeLoading(false)
    setReadmeMissing(false)
    setDetailError(null)
  }

  const handleDelete = async (name: string): Promise<void> => {
    if (!window.confirm(`Delete local model "${name}"? This cannot be undone.`)) return
    setBusyDelete(name)
    setActionError(null)
    try {
      await window.api.ollama.deleteModel(name)
      if (detailName === name) closeDetail()
      await onRefreshModels()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyDelete(null)
    }
  }

  const handlePull = async (name: string): Promise<void> => {
    if (pulling) return
    if (isCloudModelRef(name)) {
      setActionError(formatPullError('file does not exist', name))
      return
    }
    setActionError(null)
    setPulling(name)
    setPullProgress({ model: name, status: 'starting' })
    try {
      await window.api.ollama.pullModel(name)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      setActionError(formatPullError(raw, name))
      setPulling(null)
    }
  }

  /** List Download: resolve a concrete local tag before pulling. */
  const handleDownloadFromList = async (modelName: string): Promise<void> => {
    if (pulling) return
    setActionError(null)
    setPulling(modelName)
    setPullProgress({ model: modelName, status: 'resolving tag…' })
    try {
      const detail = await window.api.ollama.getLibraryModel(modelName)
      const target = pickLocalPullTag(detail.name, detail.tags)
      if (!target) {
        setPulling(null)
        setPullProgress(null)
        setActionError(
          `"${modelName}" has no local downloadable tags. Open details to inspect cloud-only options.`
        )
        void openRemoteDetail(modelName)
        return
      }
      setPulling(target)
      setPullProgress({ model: target, status: 'starting' })
      await window.api.ollama.pullModel(target)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      setActionError(formatPullError(raw, modelName))
      setPulling(null)
    }
  }

  const pullPct =
    pullProgress?.total && pullProgress.completed != null && pullProgress.total > 0
      ? Math.min(100, Math.round((pullProgress.completed / pullProgress.total) * 100))
      : null

  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="titlebar-drag titlebar-overlay-pad flex items-center justify-between border-b border-[#243041] px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold text-[#f0f4f8]">Models</h2>
          <p className="text-xs text-[#8b9aab]">
            Manage installed models and browse the Ollama library
          </p>
        </div>
        <div className="titlebar-no-drag flex gap-1 rounded-lg border border-[#2a3a4d] bg-[#121820] p-0.5">
          {(['installed', 'library'] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${
                tab === id
                  ? 'bg-[#1a3050] text-[#9ec5f0]'
                  : 'text-[#8b9aab] hover:text-[#e7ecf1]'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
      </header>

      {(actionError || pullProgress?.error) && (
        <div className="border-b border-rose-900/40 bg-rose-950/30 px-5 py-2 text-xs text-rose-200">
          {actionError || pullProgress?.error}
        </div>
      )}

      {pulling && (
        <div className="border-b border-[#243041] bg-[#121820] px-5 py-2">
          <div className="mb-1 flex items-center justify-between text-[11px] text-[#8b9aab]">
            <span>
              Pulling <span className="text-[#e7ecf1]">{pulling}</span>
              {pullProgress?.status ? ` · ${pullProgress.status}` : ''}
            </span>
            <button
              type="button"
              className="text-[#9ec5f0] hover:underline"
              onClick={() => void window.api.ollama.abortPull()}
            >
              Cancel
            </button>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[#1a2430]">
            <div
              className="h-full rounded-full bg-[#2d6cb5] transition-all"
              style={{ width: `${pullPct ?? 35}%`, opacity: pullPct == null ? 0.5 : 1 }}
            />
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={libraryScrollRef} className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === 'installed' ? (
            <div className="space-y-4">
              {!ollamaOk && (
                <p className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                  Ollama is offline. Installed models cannot be refreshed until it reconnects.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={installedQuery}
                  onChange={(e) => setInstalledQuery(e.target.value)}
                  placeholder="Filter installed models…"
                  className="min-w-[12rem] flex-1 rounded-lg border border-[#2a3a4d] bg-[#0f1419] px-3 py-2 text-sm text-[#e7ecf1] placeholder:text-[#6b7a8c] focus:border-[#2d6cb5] focus:outline-none"
                />
                <select
                  value={installedSort}
                  onChange={(e) =>
                    setInstalledSort(e.target.value as InstalledSort)
                  }
                  className="rounded-lg border border-[#2a3a4d] bg-[#0f1419] px-2 py-2 text-xs text-[#e7ecf1]"
                >
                  <option value="name">Name</option>
                  <option value="smallest">Smallest</option>
                  <option value="largest">Largest</option>
                </select>
                <button
                  type="button"
                  onClick={() => void onRefreshModels()}
                  className="rounded-lg border border-[#2a3a4d] px-3 py-2 text-xs text-[#c5d0dc] hover:bg-[#1a2430]"
                >
                  Refresh
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[null, 'tools', 'vision', 'image', 'thinking', 'embedding'].map((cap) => (
                  <button
                    key={cap ?? 'all'}
                    type="button"
                    onClick={() => setInstalledCap(cap)}
                    className={`rounded-full px-2.5 py-1 text-[11px] ${
                      installedCap === cap
                        ? 'bg-[#1a3050] text-[#9ec5f0]'
                        : 'bg-[#1a2430] text-[#8b9aab] hover:text-[#e7ecf1]'
                    }`}
                  >
                    {cap ?? 'All'}
                  </button>
                ))}
              </div>

              {installedSlice.length === 0 ? (
                <p className="py-10 text-center text-sm text-[#6b7a8c]">
                  No installed models match.
                </p>
              ) : (
                <ul className="space-y-2">
                  {installedSlice.map((m) => (
                    <li key={m.name}>
                      <div className="flex w-full items-start justify-between gap-3 rounded-xl border border-[#2a3a4d] bg-[#121820] px-4 py-3 hover:border-[#3a4a5d] hover:bg-[#161d27]">
                        <button
                          type="button"
                          onClick={() => void openLocalDetail(m.name)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate font-medium text-[#f0f4f8]">
                              {m.name}
                            </span>
                            {m.name === selectedModel && (
                              <span className="rounded bg-[#1a3050] px-1.5 py-0.5 text-[10px] uppercase text-[#9ec5f0]">
                                Active
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-[#8b9aab]">
                            {formatBytes(m.size)} · {formatDate(m.modifiedAt)}
                            {m.family ? ` · ${m.family}` : ''}
                          </p>
                          {m.tags.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {m.tags.slice(0, 6).map((t) => (
                                <span
                                  key={t}
                                  className="rounded bg-[#1a2430] px-1.5 py-0.5 text-[10px] text-[#9aa8b8]"
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                        <div className="flex shrink-0 items-start gap-1.5">
                          <button
                            type="button"
                            onClick={() => onUseInChat(m.name)}
                            className="rounded-md bg-[#2d6cb5] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#3a7cc9]"
                          >
                            Use in chat
                          </button>
                          <button
                            type="button"
                            title="Delete model"
                            aria-label={`Delete ${m.name}`}
                            disabled={busyDelete === m.name}
                            onClick={() => void handleDelete(m.name)}
                            className="flex h-7 w-7 items-center justify-center rounded-md border border-rose-900/40 text-rose-300 hover:bg-rose-950/40 disabled:opacity-50"
                          >
                            <TrashIcon />
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {installedPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2 text-xs text-[#8b9aab]">
                  <button
                    type="button"
                    disabled={installedPage <= 1}
                    onClick={() => setInstalledPage((p) => p - 1)}
                    className="rounded border border-[#2a3a4d] px-2 py-1 disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <span>
                    Page {installedPage} / {installedPages}
                  </span>
                  <button
                    type="button"
                    disabled={installedPage >= installedPages}
                    onClick={() => setInstalledPage((p) => p + 1)}
                    className="rounded border border-[#2a3a4d] px-2 py-1 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  setLibraryQuery(libraryDraft.trim())
                }}
              >
                <input
                  value={libraryDraft}
                  onChange={(e) => setLibraryDraft(e.target.value)}
                  placeholder="Search Ollama library…"
                  className="min-w-[12rem] flex-1 rounded-lg border border-[#2a3a4d] bg-[#0f1419] px-3 py-2 text-sm text-[#e7ecf1] placeholder:text-[#6b7a8c] focus:border-[#2d6cb5] focus:outline-none"
                />
                <select
                  value={libraryOrder}
                  onChange={(e) => {
                    setLibraryOrder(e.target.value as LibrarySort)
                  }}
                  className="rounded-lg border border-[#2a3a4d] bg-[#0f1419] px-2 py-2 text-xs text-[#e7ecf1]"
                >
                  <option value="popular">Popular</option>
                  <option value="newest">Newest</option>
                  <option value="smallest">Smallest</option>
                  <option value="largest">Largest</option>
                </select>
                <button
                  type="submit"
                  className="rounded-lg bg-[#2d6cb5] px-3 py-2 text-xs font-medium text-white hover:bg-[#3a7cc9]"
                >
                  Search
                </button>
              </form>

              <div className="flex flex-wrap gap-1.5">
                {LIBRARY_FILTERS.map((f) => (
                  <button
                    key={f.label}
                    type="button"
                    onClick={() => {
                      setLibraryCap(f.id)
                    }}
                    className={`rounded-full px-2.5 py-1 text-[11px] ${
                      libraryCap === f.id
                        ? 'bg-[#1a3050] text-[#9ec5f0]'
                        : 'bg-[#1a2430] text-[#8b9aab] hover:text-[#e7ecf1]'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {libraryError && (
                <p className="rounded-lg border border-rose-900/40 bg-rose-950/20 px-3 py-2 text-xs text-rose-200">
                  {libraryError}
                </p>
              )}

              {libraryLoading && libraryModels.length === 0 ? (
                <p className="py-10 text-center text-sm text-[#6b7a8c]">Loading library…</p>
              ) : libraryModels.length === 0 ? (
                <p className="py-10 text-center text-sm text-[#6b7a8c]">No models found.</p>
              ) : (
                <ul className="space-y-2">
                  {libraryModels.map((m) => {
                    const installed = isInstalledFamily(models, m.name)
                    const cloudOnly =
                      m.capabilities.includes('cloud') && !m.minSize
                    return (
                      <li key={m.name}>
                        <div className="flex gap-2 rounded-xl border border-[#2a3a4d] bg-[#121820] px-4 py-3">
                          <button
                            type="button"
                            onClick={() => void openRemoteDetail(m.name)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-[#f0f4f8]">{m.name}</span>
                              {m.minSize && (
                                <span className="rounded bg-[#1a2430] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#c5d0dc]">
                                  from {m.minSize}
                                </span>
                              )}
                              {installed && (
                                <span className="rounded bg-emerald-950/50 px-1.5 py-0.5 text-[10px] uppercase text-emerald-300">
                                  Installed
                                </span>
                              )}
                              {cloudOnly && (
                                <span className="rounded bg-[#2a2438] px-1.5 py-0.5 text-[10px] uppercase text-[#b39ddb]">
                                  Cloud
                                </span>
                              )}
                            </div>
                            {m.description && (
                              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[#8b9aab]">
                                {m.description}
                              </p>
                            )}
                            <div className="mt-2 flex flex-wrap gap-1">
                              {m.capabilities.map((c) => (
                                <span
                                  key={c}
                                  className="rounded bg-[#1a2430] px-1.5 py-0.5 text-[10px] capitalize text-[#9aa8b8]"
                                >
                                  {c}
                                </span>
                              ))}
                              {m.pulls && (
                                <span className="text-[10px] text-[#6b7a8c]">
                                  {m.pulls} pulls
                                </span>
                              )}
                              {m.tagCount && (
                                <span className="text-[10px] text-[#6b7a8c]">
                                  · {m.tagCount} tags
                                </span>
                              )}
                            </div>
                          </button>
                          {cloudOnly ? (
                            <button
                              type="button"
                              onClick={() => void openRemoteDetail(m.name)}
                              className="h-fit shrink-0 rounded-md border border-[#2a3a4d] px-2.5 py-1.5 text-[11px] text-[#c5d0dc] hover:bg-[#1a2430]"
                            >
                              View tags
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={Boolean(pulling)}
                              title="Download smallest local tag (or :latest)"
                              onClick={() => void handleDownloadFromList(m.name)}
                              className="h-fit shrink-0 rounded-md bg-[#2d6cb5] px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-[#3a7cc9] disabled:opacity-50"
                            >
                              Download
                            </button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}

              <div
                ref={librarySentinelRef}
                className="flex min-h-10 items-center justify-center py-3 text-xs text-[#6b7a8c]"
              >
                {libraryLoadingMore ? (
                  <div
                    className="library-load-more flex items-center gap-2"
                    role="status"
                    aria-live="polite"
                  >
                    <span>Loading more</span>
                    <span className="library-load-dots" aria-hidden>
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                ) : libraryModels.length > 0 && !libraryHasMore ? (
                  <span className="library-load-end">End of results</span>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {detailKind && (
          <aside className="flex w-[min(100%,28rem)] shrink-0 flex-col border-l border-[#243041] bg-[#121820]">
            <div className="flex items-start justify-between gap-2 border-b border-[#243041] px-4 py-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-[#f0f4f8]">
                  {detailName}
                </h3>
                <p className="text-[10px] uppercase tracking-wider text-[#6b7a8c]">
                  {detailKind === 'local' ? 'Installed' : 'Library'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeDetail}
                className="text-[#8b9aab] hover:text-[#e7ecf1]"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 text-sm">
              {detailLoading && (
                <p className="text-xs text-[#6b7a8c]">Loading details…</p>
              )}
              {detailError && (
                <p className="text-xs text-rose-300">{detailError}</p>
              )}

              {detailKind === 'local' && localDetail && (
                <div className="space-y-3">
                  <p className="text-xs text-[#8b9aab]">
                    {formatBytes(localDetail.size)} · {formatDate(localDetail.modifiedAt)}
                  </p>
                  {localDetail.capabilities && localDetail.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {localDetail.capabilities.map((c) => (
                        <span
                          key={c}
                          className="rounded bg-[#1a2430] px-1.5 py-0.5 text-[10px] text-[#9aa8b8]"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  {localDetail.details && (
                    <dl className="space-y-1 text-xs text-[#9aa8b8]">
                      {localDetail.details.family && (
                        <div>
                          <dt className="text-[#6b7a8c]">Family</dt>
                          <dd>{localDetail.details.family}</dd>
                        </div>
                      )}
                      {localDetail.details.parameter_size && (
                        <div>
                          <dt className="text-[#6b7a8c]">Parameters</dt>
                          <dd>{localDetail.details.parameter_size}</dd>
                        </div>
                      )}
                      {localDetail.details.quantization_level && (
                        <div>
                          <dt className="text-[#6b7a8c]">Quantization</dt>
                          <dd>{localDetail.details.quantization_level}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                  <div>
                    <h4 className="mb-2 text-[10px] uppercase tracking-wider text-[#6b7a8c]">
                      README
                    </h4>
                    {readmeLoading ? (
                      <p className="text-xs text-[#6b7a8c]">Loading README…</p>
                    ) : readmeMd ? (
                      <div className="rounded-lg bg-[#0f1419] px-3 py-2 text-[12px] leading-relaxed text-[#c5d0dc] [&_.markdown-body]:text-[#c5d0dc] [&_.markdown-body_h1]:text-sm [&_.markdown-body_h2]:text-sm [&_.markdown-body_h3]:text-[13px]">
                        <MarkdownContent content={readmeMd} allowHtml />
                      </div>
                    ) : readmeMissing ? (
                      <p className="text-xs text-[#6b7a8c]">
                        No README found on the Ollama library for this model.
                      </p>
                    ) : null}
                  </div>
                  {localDetail.system && (
                    <div>
                      <h4 className="mb-1 text-[10px] uppercase text-[#6b7a8c]">System</h4>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[#0f1419] p-2 text-[11px] text-[#c5d0dc]">
                        {localDetail.system}
                      </pre>
                    </div>
                  )}
                  {localDetail.parameters && (
                    <div>
                      <h4 className="mb-1 text-[10px] uppercase text-[#6b7a8c]">
                        Parameters
                      </h4>
                      <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-[#0f1419] p-2 text-[11px] text-[#c5d0dc]">
                        {localDetail.parameters}
                      </pre>
                    </div>
                  )}
                  {localDetail.template && (
                    <div>
                      <h4 className="mb-1 text-[10px] uppercase text-[#6b7a8c]">Template</h4>
                      <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-[#0f1419] p-2 text-[11px] text-[#9aa8b8]">
                        {localDetail.template.slice(0, 2000)}
                      </pre>
                    </div>
                  )}
                  <div className="flex flex-col gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (detailName) onUseInChat(detailName)
                      }}
                      className="rounded-lg bg-[#2d6cb5] px-3 py-2 text-xs font-medium text-white hover:bg-[#3a7cc9]"
                    >
                      Use in chat
                    </button>
                    <button
                      type="button"
                      title="Delete model"
                      aria-label={detailName ? `Delete ${detailName}` : 'Delete model'}
                      disabled={!detailName || busyDelete === detailName}
                      onClick={() => detailName && void handleDelete(detailName)}
                      className="flex items-center justify-center gap-2 rounded-lg border border-rose-900/40 px-3 py-2 text-xs text-rose-300 hover:bg-rose-950/30 disabled:opacity-50"
                    >
                      <TrashIcon />
                      Delete
                    </button>
                  </div>
                </div>
              )}

              {detailKind === 'remote' && remoteDetail && (
                <div className="space-y-3">
                  {remoteDetail.description && (
                    <p className="text-xs leading-relaxed text-[#8b9aab]">
                      {remoteDetail.description}
                    </p>
                  )}
                  {remoteDetail.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {remoteDetail.capabilities.map((c) => (
                        <span
                          key={c}
                          className="rounded bg-[#1a2430] px-1.5 py-0.5 text-[10px] capitalize text-[#9aa8b8]"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  <div>
                    <h4 className="mb-2 text-[10px] uppercase tracking-wider text-[#6b7a8c]">
                      Tags
                      {smallestDiskLabel(remoteDetail.tags.map((t) => t.size)) && (
                        <span className="ml-2 normal-case tracking-normal text-[#8b9aab]">
                          · smallest{' '}
                          {smallestDiskLabel(remoteDetail.tags.map((t) => t.size))}
                        </span>
                      )}
                    </h4>
                    <ul className="space-y-1.5">
                      {remoteDetail.tags.slice(0, 40).map((tag) => {
                        const installed = isTagInstalled(models, tag.name)
                        const cloud = isCloudModelRef(tag.name)
                        return (
                          <li
                            key={tag.name}
                            className="flex items-center justify-between gap-2 rounded-lg bg-[#0f1419] px-2.5 py-2"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-xs text-[#e7ecf1]">
                                  {tag.name}
                                </span>
                                {installed && (
                                  <span className="shrink-0 text-[10px] text-emerald-400">
                                    ✓
                                  </span>
                                )}
                                {cloud && (
                                  <span className="shrink-0 rounded bg-[#2a2438] px-1 py-0.5 text-[9px] uppercase text-[#b39ddb]">
                                    Cloud
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[#6b7a8c]">
                                {tag.size ? (
                                  <span className="rounded bg-[#1a3050] px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-[#9ec5f0]">
                                    {tag.size}
                                  </span>
                                ) : null}
                                {tag.context && (
                                  <span className="rounded bg-[#1a2430] px-1.5 py-0.5">
                                    {tag.context} ctx
                                  </span>
                                )}
                                {tag.input && (
                                  <span className="rounded bg-[#1a2430] px-1.5 py-0.5">
                                    {tag.input}
                                  </span>
                                )}
                              </div>
                            </div>
                            {cloud ? (
                              <span
                                className="shrink-0 px-2 py-1 text-[10px] text-[#6b7a8c]"
                                title="Cloud tags are not downloaded locally"
                              >
                                Not local
                              </span>
                            ) : (
                              <button
                                type="button"
                                disabled={Boolean(pulling) || installed}
                                onClick={() => void handlePull(tag.name)}
                                className="shrink-0 rounded-md border border-[#2a3a4d] px-2 py-1 text-[10px] text-[#9ec5f0] hover:bg-[#1a2430] disabled:opacity-40"
                              >
                                {installed ? 'Installed' : 'Pull'}
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                  {readmeLoading || readmeMd || readmeMissing ? (
                    <div>
                      <h4 className="mb-2 text-[10px] uppercase tracking-wider text-[#6b7a8c]">
                        README
                      </h4>
                      {readmeLoading ? (
                        <p className="text-xs text-[#6b7a8c]">Loading README…</p>
                      ) : readmeMd ? (
                        <div className="rounded-lg bg-[#0f1419] px-3 py-2 text-[12px] leading-relaxed text-[#c5d0dc] [&_.markdown-body]:text-[#c5d0dc] [&_.markdown-body_h1]:text-sm [&_.markdown-body_h2]:text-sm [&_.markdown-body_h3]:text-[13px]">
                          <MarkdownContent content={readmeMd} allowHtml />
                        </div>
                      ) : (
                        <p className="text-xs text-[#6b7a8c]">
                          No README found on the Ollama library for this model.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
