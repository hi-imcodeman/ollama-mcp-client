import type { OllamaModel } from '../../shared/types'
import {
  chatOnce,
  chatStream,
  detectVisionSupport,
  getModelInfo,
  listModels,
  modelIsImageGen,
  resolveContextLength,
  type OllamaModelInfo
} from '../ollama'
import type { LlmModelInfo, LlmProvider } from './types'

function mapInfo(info: OllamaModelInfo): LlmModelInfo {
  return {
    capabilities: info.capabilities,
    contextLength: undefined
  }
}

export const ollamaLlmProvider: LlmProvider = {
  id: 'ollama',

  chatStream(options) {
    return chatStream(options)
  },

  chatOnce(options) {
    return chatOnce(options)
  },

  listModelsForChat() {
    return listModels()
  },

  async getModelInfo(model) {
    try {
      return mapInfo(await getModelInfo(model))
    } catch {
      return null
    }
  },

  modelIsImageGen(model, info) {
    const ollamaInfo: OllamaModelInfo | null = info
      ? { capabilities: info.capabilities }
      : null
    return modelIsImageGen(model, ollamaInfo)
  },

  detectVisionSupport(model, info) {
    const ollamaInfo: OllamaModelInfo | null = info
      ? { capabilities: info.capabilities }
      : null
    return detectVisionSupport(model, ollamaInfo)
  },

  async resolveContextLength(model, info) {
    const ollamaInfo: OllamaModelInfo | null = info
      ? { capabilities: info.capabilities }
      : null
    const limit = await resolveContextLength(model, ollamaInfo)
    return limit ?? null
  }
}
