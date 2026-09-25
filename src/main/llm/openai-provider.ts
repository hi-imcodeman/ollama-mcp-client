import type { OllamaModel } from '../../shared/types'
import {
  isOpenAiImageGenModel,
  isOpenAiVisionModel
} from '../../shared/openai-models'
import {
  getOpenaiModelEnabledMap,
  getOpenaiModelsCatalog
} from '../config-store'
import {
  fetchOpenAiChatModels,
  isChatModelId,
  openAiChatOnce,
  openAiChatStream
} from '../openai-client'
import type { OllamaChatChunk, OllamaChatMessage, OllamaTool } from '../ollama'
import type { LlmModelInfo, LlmProvider } from './types'

const DEFAULT_CTX = 128_000

function openAiModelTags(id: string): string[] {
  const tags: string[] = ['openai']
  if (isOpenAiImageGenModel(id)) tags.push('image')
  if (isOpenAiVisionModel(id)) tags.push('vision')
  const lower = id.toLowerCase()
  if (lower.startsWith('o1') || lower.startsWith('o3') || lower.includes('reasoning')) {
    tags.push('thinking')
  }
  return tags
}

export const openaiLlmProvider: LlmProvider = {
  id: 'openai',

  async chatStream(options) {
    const result = await openAiChatStream({
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      signal: options.signal,
      onChunk: options.onChunk
    })
    options.onChunk({ done: true })
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      promptEvalCount: result.promptEvalCount,
      evalCount: result.evalCount,
      evalDurationNs: undefined,
      usage: result.usage
    }
  },

  chatOnce(options) {
    return openAiChatOnce({
      model: options.model,
      messages: options.messages,
      signal: options.signal
    })
  },

  async listModelsForChat(): Promise<OllamaModel[]> {
    const catalog = getOpenaiModelsCatalog()
    const enabled = getOpenaiModelEnabledMap()
    return catalog
      .filter((m) => isChatModelId(m.id))
      .filter((m) => enabled[m.id])
      .map((m) => ({
        name: m.id,
        size: 0,
        modifiedAt: m.created ? new Date(m.created * 1000).toISOString() : '',
        tags: openAiModelTags(m.id),
        capabilities: openAiModelTags(m.id)
      }))
  },

  async getModelInfo(model) {
    try {
      await fetchOpenAiChatModels()
    } catch {
      // catalog may still be cached
    }
    const info: LlmModelInfo = {
      contextLength: DEFAULT_CTX,
      capabilities: openAiModelTags(model)
    }
    return info
  },

  modelIsImageGen(model) {
    return isOpenAiImageGenModel(model)
  },

  detectVisionSupport(model, _info) {
    return isOpenAiVisionModel(model) ? 'yes' : 'unknown'
  },

  async resolveContextLength(_model, info) {
    return info?.contextLength ?? DEFAULT_CTX
  }
}
