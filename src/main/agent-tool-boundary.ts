import type { OllamaTool } from './ollama'
import { editImageToolDefinition, generateImageToolDefinition } from './image-gen-tool'

export function buildAgentImageTools(baseTools: OllamaTool[]): OllamaTool[] {
  return [
    ...baseTools,
    generateImageToolDefinition(),
    editImageToolDefinition()
  ]
}
