import type { LlmProvider, OpenAiStatus } from '../../shared/types'
import {
  getLlmProvider,
  getOpenaiApiKey,
  getOpenaiEnabled,
  getOpenaiModelEnabledMap,
  getOpenaiModelsCatalog,
  getOpenaiValidationState
} from '../config-store'

export interface EffectiveLlmProviderResult {
  configured: LlmProvider
  effective: LlmProvider
  fallback: boolean
  reason?: string
}

export function resolveEffectiveLlmProvider(): EffectiveLlmProviderResult {
  const configured = getLlmProvider()
  if (configured !== 'openai') {
    return { configured, effective: 'ollama', fallback: false }
  }

  if (!getOpenaiEnabled()) {
    return {
      configured,
      effective: 'ollama',
      fallback: true,
      reason: 'OpenAI is disabled in Settings.'
    }
  }

  if (!getOpenaiApiKey()) {
    return {
      configured,
      effective: 'ollama',
      fallback: true,
      reason: 'OpenAI API key is not configured.'
    }
  }

  const { ok, error } = getOpenaiValidationState()
  if (!ok) {
    return {
      configured,
      effective: 'ollama',
      fallback: true,
      reason: error ?? 'OpenAI API key is not validated.'
    }
  }

  return { configured, effective: 'openai', fallback: false }
}

export function getOpenAiStatus(): OpenAiStatus {
  const enabled = getOpenaiEnabled()
  const { ok, error } = getOpenaiValidationState()
  const catalog = getOpenaiModelsCatalog()
  const enabledMap = getOpenaiModelEnabledMap()
  const enabledCount = catalog.filter((m) => enabledMap[m.id]).length
  return {
    enabled,
    validationOk: ok,
    validationError: error,
    catalogCount: catalog.length,
    enabledCount
  }
}
