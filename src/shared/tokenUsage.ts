import type { TokenUsageBreakdown } from './types'

export function emptyTokenUsage(provider: 'ollama' | 'openai'): TokenUsageBreakdown {
  return {
    provider,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0
  }
}

export function mergeTokenUsage(
  acc: TokenUsageBreakdown,
  delta: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedPromptTokens?: number
    reasoningTokens?: number
    ollamaPromptEval?: number
    ollamaEval?: number
  }
): TokenUsageBreakdown {
  const next = { ...acc }
  next.promptTokens += delta.promptTokens ?? 0
  next.completionTokens += delta.completionTokens ?? 0
  next.totalTokens +=
    delta.totalTokens ?? (delta.promptTokens ?? 0) + (delta.completionTokens ?? 0)
  next.cachedPromptTokens = (next.cachedPromptTokens ?? 0) + (delta.cachedPromptTokens ?? 0)
  next.reasoningTokens = (next.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0)
  if (delta.ollamaPromptEval != null) {
    next.ollamaPromptEval = (next.ollamaPromptEval ?? 0) + delta.ollamaPromptEval
  }
  if (delta.ollamaEval != null) {
    next.ollamaEval = (next.ollamaEval ?? 0) + delta.ollamaEval
  }
  return next
}

export function hasTokenUsageData(u: TokenUsageBreakdown): boolean {
  return (
    u.promptTokens > 0 ||
    u.completionTokens > 0 ||
    u.totalTokens > 0 ||
    (u.cachedPromptTokens ?? 0) > 0 ||
    (u.reasoningTokens ?? 0) > 0
  )
}
