import type { TokenUsageBreakdown } from '../../../shared/types'
import { formatTokenCount } from '../../../shared/contextUsage'

export function formatContextTooltip(options: {
  contextUsed?: number
  contextLimit?: number
  tokenUsage?: TokenUsageBreakdown
  multiCallTurn?: boolean
}): string {
  const { contextUsed, contextLimit, tokenUsage, multiCallTurn } = options
  const lines: string[] = []

  const hasContext =
    contextUsed != null &&
    contextLimit != null &&
    contextLimit > 0 &&
    contextUsed >= 0

  if (hasContext) {
    const pct = Math.max(0, (contextUsed / contextLimit) * 100)
    lines.push(
      `Context window when this reply finished: ${Math.round(contextUsed)} / ${Math.round(contextLimit)} tokens (${Math.round(pct)}%)`
    )
  }

  if (tokenUsage) {
    if (lines.length === 0) lines.push('Token usage for this reply')
    if (tokenUsage.provider === 'openai') {
      lines.push(`Input tokens: ${formatTokenCount(tokenUsage.promptTokens)}`)
      if ((tokenUsage.cachedPromptTokens ?? 0) > 0) {
        lines.push(
          `Cached input tokens: ${formatTokenCount(tokenUsage.cachedPromptTokens ?? 0)}`
        )
      }
      lines.push(`Output tokens: ${formatTokenCount(tokenUsage.completionTokens)}`)
      if ((tokenUsage.reasoningTokens ?? 0) > 0) {
        lines.push(
          `Reasoning tokens: ${formatTokenCount(tokenUsage.reasoningTokens ?? 0)}`
        )
      }
      lines.push(`Total tokens: ${formatTokenCount(tokenUsage.totalTokens)}`)
    } else {
      lines.push(`Prompt tokens: ${formatTokenCount(tokenUsage.promptTokens)}`)
      lines.push(`Generated tokens: ${formatTokenCount(tokenUsage.completionTokens)}`)
      lines.push(`Total tokens: ${formatTokenCount(tokenUsage.totalTokens)}`)
    }
    if (multiCallTurn) {
      lines.push('(Summed across multiple model calls this turn)')
    }
  } else if (hasContext && lines.length === 1) {
    // Same single-line tooltip as before when no breakdown
    return lines[0]!
  }

  if (lines.length === 0) return ''
  return lines.join('\n')
}
