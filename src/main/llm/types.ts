import type { LlmProvider as LlmProviderId, OllamaModel } from '../../shared/types'
import type { OpenAiUsageDetails } from '../openai-client'
import type { OllamaChatChunk, OllamaChatMessage, OllamaTool } from '../ollama'

export interface LlmChatStreamResult {
  content: string
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
  promptEvalCount?: number
  evalCount?: number
  evalDurationNs?: number
  /** Full usage from OpenAI SSE when available. */
  usage?: OpenAiUsageDetails
}

export interface LlmModelInfo {
  capabilities?: string[]
  contextLength?: number
}

export interface LlmProvider {
  readonly id: LlmProviderId
  chatStream(options: {
    model: string
    messages: OllamaChatMessage[]
    tools?: OllamaTool[]
    signal?: AbortSignal
    numCtx?: number
    numPredict?: number
    onChunk: (chunk: OllamaChatChunk) => void
  }): Promise<LlmChatStreamResult>
  chatOnce(options: {
    model: string
    messages: OllamaChatMessage[]
    signal?: AbortSignal
    numCtx?: number
    numPredict?: number
    keepAlive?: number
  }): Promise<string>
  listModelsForChat(): Promise<OllamaModel[]>
  getModelInfo(model: string): Promise<LlmModelInfo | null>
  modelIsImageGen(model: string, info?: LlmModelInfo | null): boolean
  detectVisionSupport(
    model: string,
    info?: LlmModelInfo | null
  ): 'yes' | 'no' | 'unknown'
  resolveContextLength(
    model: string,
    info?: LlmModelInfo | null
  ): Promise<number | null>
}
