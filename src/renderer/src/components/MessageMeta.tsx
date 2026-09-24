import type { ReactNode } from 'react'
import type { TokenUsageBreakdown } from '../../../shared/types'
import { formatTokenCount } from '../../../shared/contextUsage'
import { contextUsageColor } from '../lib/contextUsage'
import { formatContextTooltip } from '../lib/formatTokenUsageTooltip'
import { useSegmentTimer } from '../hooks/useSegmentTimer'

interface MessageMetaProps {
  createdAt?: string
  responseMs?: number
  elapsedMs?: number
  liveTotal?: boolean
  segmentActive?: boolean
  segmentStartedAt?: number
  segmentDurationMs?: number
  totalStartedAt?: number
  tokensPerSec?: number
  model?: string
  contextUsed?: number
  contextLimit?: number
  tokenUsage?: TokenUsageBreakdown
  multiCallTurn?: boolean
  align?: 'left' | 'right'
}

export function formatMessageTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
  if (sameDay) return time
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function formatResponseMs(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

export function formatTokensPerSec(n?: number): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return ''
  const label = n >= 10 ? String(Math.round(n)) : n.toFixed(1)
  return `${label} tokens/sec`
}

export function MessageMeta({
  createdAt,
  responseMs,
  elapsedMs,
  liveTotal,
  segmentActive,
  segmentStartedAt,
  segmentDurationMs,
  totalStartedAt,
  tokensPerSec,
  model,
  contextUsed,
  contextLimit,
  tokenUsage,
  multiCallTurn,
  align = 'left'
}: MessageMetaProps): React.JSX.Element | null {
  const time = formatMessageTime(createdAt)
  const segment = useSegmentTimer({
    active: Boolean(segmentActive),
    startedAt: segmentStartedAt,
    durationMs: segmentDurationMs
  })
  const total = useSegmentTimer({
    active: Boolean(liveTotal && totalStartedAt),
    startedAt: totalStartedAt,
    durationMs: responseMs
  })
  const duration = liveTotal ? total : formatResponseMs(responseMs)
  const segmentLabel = segmentActive ? segment : formatResponseMs(segmentDurationMs)
  const elapsed = formatResponseMs(elapsedMs)
  const speed = formatTokensPerSec(tokensPerSec)
  const modelLabel = model?.trim() || ''
  const hasContext =
    contextUsed != null &&
    contextLimit != null &&
    contextLimit > 0 &&
    contextUsed >= 0
  const pct = hasContext
    ? Math.max(0, (contextUsed / contextLimit) * 100)
    : 0
  const barPct = Math.min(100, pct)
  if (!time && !duration && !segmentLabel && !elapsed && !speed && !modelLabel && !hasContext)
    return null

  const parts: ReactNode[] = []
  const push = (node: ReactNode): void => {
    if (parts.length > 0) {
      parts.push(
        <span key={`dot-${parts.length}`} aria-hidden>
          ·
        </span>
      )
    }
    parts.push(node)
  }

  if (modelLabel) {
    push(
      <span
        key="model"
        title="Model"
        className="max-w-[14rem] truncate font-medium text-[#8b9aab]"
      >
        {modelLabel}
      </span>
    )
  }
  if (time) {
    push(<span key="time">{time}</span>)
  }
  if (segmentLabel) {
    push(
      <span key="segment" title="Reply time" className="text-[#8b9aab]">
        {segmentLabel}
      </span>
    )
  }
  if (duration) {
    push(
      <span key="duration" title="Total time" className="text-[#8b9aab]">
        {duration}
      </span>
    )
  }
  if (elapsed) {
    push(
      <span key="elapsed" title="Elapsed since send" className="text-[#8b9aab]">
        {elapsed}
      </span>
    )
  }
  if (speed) {
    push(
      <span
        key="speed"
        title="Generation speed (tokens per second)"
        className="text-[#8b9aab]"
      >
        {speed}
      </span>
    )
  }
  if (hasContext) {
    const color = contextUsageColor(pct)
    const contextTitle = formatContextTooltip({
      contextUsed,
      contextLimit,
      tokenUsage,
      multiCallTurn
    })
    push(
      <span
        key="context"
        title={contextTitle}
        className="inline-flex items-center gap-1.5 font-mono"
        style={{ color }}
      >
        <span
          className="inline-block h-1 w-8 overflow-hidden rounded-full bg-[#2a313a]"
          aria-hidden
        >
          <span
            className="block h-full rounded-full"
            style={{ width: `${barPct}%`, backgroundColor: color }}
          />
        </span>
        {formatTokenCount(contextUsed)} / {formatTokenCount(contextLimit)}
        <span className="text-[#6b7a8c]">({Math.round(pct)}%)</span>
      </span>
    )
  }

  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-1.5 text-[10px] tabular-nums text-[#6b7a8c] ${
        align === 'right' ? 'justify-end' : 'justify-start'
      }`}
    >
      {parts}
    </div>
  )
}
