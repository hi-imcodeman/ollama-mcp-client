import { useState, type CSSProperties } from 'react'
import { useSegmentTimer } from '../hooks/useSegmentTimer'
import { MessageMeta } from './MessageMeta'

interface ToolCallCardProps {
  name: string
  arguments: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  result?: string
  startedAt?: number
  durationMs?: number
  elapsedMs?: number
  createdAt?: string
  model?: string
}

const STATUS_LABEL = {
  running: 'Running',
  done: 'Done',
  error: 'Error'
} as const

const STATUS_COLOR = {
  running: 'text-amber-300',
  done: 'text-emerald-400',
  error: 'text-rose-300'
} as const

export function summarizeToolArguments(
  args: Record<string, unknown>
): string[] {
  return Object.entries(args).map(([key, value]) => {
    if (key === 'images' && Array.isArray(value)) {
      return `${key}: ${value.length} attached image(s)`
    }
    if (typeof value === 'string') {
      const preview = value.length > 120 ? `${value.slice(0, 120)}…` : value
      return `${key}: ${JSON.stringify(preview)}`
    }
    const serialized = JSON.stringify(value)
    return `${key}: ${serialized === undefined ? String(value) : serialized}`
  })
}

export function ToolCallCard({
  name,
  arguments: args,
  status,
  result,
  startedAt,
  durationMs,
  elapsedMs,
  createdAt,
  model
}: ToolCallCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const argsJson = JSON.stringify(args, null, 2)
  const argumentSummary = summarizeToolArguments(args)
  const truncated =
    result && result.length > 4000 ? `${result.slice(0, 4000)}\n…` : result
  const shortName = name.includes('__') ? name.split('__').slice(1).join('__') : name
  const running = status === 'running'
  const segmentLabel = useSegmentTimer({
    active: running,
    startedAt,
    durationMs
  })

  const style = {
    '--activity-accent': '#7dd3a8',
    '--activity-ring': 'rgba(125, 211, 168, 0.35)'
  } as CSSProperties

  return (
    <div className="tool-card-enter mr-auto w-full min-w-[16rem] max-w-[min(100%,42rem)]">
      <div
        className={`overflow-hidden rounded-xl border bg-[#121820] text-left ${
          running
            ? 'tool-card-running border-[#3d5a40]'
            : status === 'error'
              ? 'border-rose-900/50'
              : 'border-[#2a3a4d]'
        }`}
        style={running ? style : undefined}
      >
        {running ? (
          <div className="activity-shimmer relative px-3.5 py-3">
            <div className="flex items-center gap-3">
              <div className="activity-orb relative h-9 w-9 shrink-0">
                <span className="activity-orb-core absolute inset-1.5 rounded-full" />
                <span className="activity-orb-ring absolute inset-0 rounded-full" />
                <span className="activity-orb-ring activity-orb-ring-delay absolute inset-0 rounded-full" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium tracking-wide text-[#f0f4f8]">
                    {shortName}
                  </span>
                  <span className="activity-dots" aria-hidden="true">
                    <span>.</span>
                    <span>.</span>
                    <span>.</span>
                  </span>
                  {segmentLabel ? (
                    <span className="ml-auto font-mono text-[11px] tabular-nums text-[#6b7a8c]">
                      {segmentLabel}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-xs text-[#8b9aab]">{STATUS_LABEL[status]}…</p>
                {argumentSummary.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {argumentSummary.map((line, index) => (
                      <div
                        key={`${line}-${index}`}
                        className="truncate font-mono text-[10px] text-[#9fb0bf]"
                        title={line}
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="activity-progress mt-3 h-1 overflow-hidden rounded-full bg-[#1a2430]">
              <div className="activity-progress-bar h-full rounded-full" />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center justify-between px-3.5 py-2 text-left hover:bg-[#1a2430]"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[#8b9aab]">
                Tool call
              </span>
              <span className="truncate text-[11px] text-[#6b7a8c]">{shortName}</span>
              <span className={`text-[10px] uppercase ${STATUS_COLOR[status]}`}>
                {STATUS_LABEL[status]}
              </span>
              {segmentLabel ? (
                <span className="font-mono text-[11px] tabular-nums text-[#6b7a8c]">
                  {segmentLabel}
                </span>
              ) : null}
            </div>
            <span className="shrink-0 font-mono text-[11px] text-[#6b7a8c]">
              {open ? '−' : '+'}
            </span>
          </button>
        )}

        {open && !running && (
          <div className="space-y-2 border-t border-[#243041] px-3.5 py-2.5">
            <div className="min-w-0 rounded bg-[#0f1419] px-2 py-1.5">
              <div className="truncate text-xs font-medium text-[#e7ecf1]">
                {shortName}
              </div>
              <div className="truncate font-mono text-[10px] text-[#6b7a8c]">
                {name}
              </div>
            </div>
            <pre className="max-h-32 overflow-auto rounded bg-[#0f1419] p-2 font-mono text-[11px] leading-relaxed text-[#8b9aab]">
              {argsJson}
            </pre>
            {truncated !== undefined && (
              <pre className="max-h-48 overflow-auto rounded border border-[#243041] bg-[#0f1419] p-2 font-mono text-[11px] leading-relaxed text-[#c5d0dc]">
                {truncated}
              </pre>
            )}
          </div>
        )}
      </div>
      <MessageMeta
        createdAt={createdAt}
        model={model}
        elapsedMs={running ? undefined : elapsedMs}
        align="left"
      />
    </div>
  )
}
