import {
  getDefaultImageModel,
  getOpenaiModelEnabledMap,
  getOpenaiModelsCatalog
} from './config-store'
import { isOpenAiImageGenModel } from '../shared/openai-models'
import type { LlmProvider } from '../shared/types'
import { generateImageBase64 } from './ollama-image'
import {
  editOpenAiImageBase64,
  generateOpenAiImageBase64
} from './openai-image'
import {
  getOllamaStatus,
  listModels,
  modelIsImageGen,
  type OllamaTool
} from './ollama'

export const GENERATE_IMAGE_NAME = 'generate_image'

/** Pure: pick configured model if still in list, else first, else null. */
export function resolveDefaultImageModel(
  configured: string | null,
  imageModelNames: string[]
): string | null {
  if (imageModelNames.length === 0) return null
  if (configured && imageModelNames.includes(configured)) return configured
  return imageModelNames[0] ?? null
}

export function resolveImageModelForProvider(
  provider: LlmProvider,
  configured: string | null,
  availableModels: string[]
): string | null {
  if (provider === 'openai') {
    return resolveDefaultImageModel(configured, availableModels)
  }
  return resolveDefaultImageModel(configured, availableModels)
}

export function isImageModelAvailable(
  _provider: LlmProvider,
  model: string,
  availableModels: string[]
): boolean {
  return availableModels.includes(model)
}

export interface AvailableImageModel {
  provider: LlmProvider
  model: string
}

export function resolveImageBackend(
  configured: string | null,
  available: AvailableImageModel[],
  fallbackProvider?: LlmProvider
): AvailableImageModel | null {
  if (available.length === 0) return null
  const configuredEntry = available.find((entry) => entry.model === configured)
  if (configuredEntry) return configuredEntry
  if (fallbackProvider) {
    return available.find((entry) => entry.provider === fallbackProvider) ?? null
  }
  return available[0] ?? null
}

export async function listInstalledImageModelNames(): Promise<string[]> {
  const models = await listModels()
  return models
    .filter((m) => modelIsImageGen(m.name, { capabilities: m.capabilities }))
    .map((m) => m.name)
}

export async function listAvailableImageModels(): Promise<AvailableImageModel[]> {
  const imageModels: AvailableImageModel[] = []

  const ollamaStatus = await getOllamaStatus()
  if (ollamaStatus.ok && ollamaStatus.imageGenSupported !== false) {
    try {
      const names = await listInstalledImageModelNames()
      imageModels.push(
        ...names.map((model) => ({ provider: 'ollama' as const, model }))
      )
    } catch {
      // OpenAI image models can still be used when Ollama is unavailable.
    }
  }

  const catalog = getOpenaiModelsCatalog()
  const enabled = getOpenaiModelEnabledMap()
  imageModels.push(
    ...catalog
      .map((entry) => entry.id)
      .filter((id) => enabled[id] === true && isOpenAiImageGenModel(id))
      .map((model) => ({ provider: 'openai' as const, model }))
  )

  return imageModels
}

export async function listAvailableImageModelNames(
  provider: LlmProvider
): Promise<string[]> {
  if (provider === 'openai') {
    const catalog = getOpenaiModelsCatalog()
    const enabled = getOpenaiModelEnabledMap()
    return catalog
      .map((entry) => entry.id)
      .filter((id) => enabled[id] === true && isOpenAiImageGenModel(id))
  }

  const status = await getOllamaStatus()
  if (!status.ok || status.imageGenSupported === false) return []
  try {
    return await listInstalledImageModelNames()
  } catch {
    return []
  }
}

export function shouldOfferGenerateImageTool(
  provider: LlmProvider,
  selectedModel: string
): Promise<boolean>
export function shouldOfferGenerateImageTool(selectedModel: string): Promise<boolean>
export async function shouldOfferGenerateImageTool(
  providerOrSelectedModel: LlmProvider | string,
  selectedModelArg?: string
): Promise<boolean> {
  const provider: LlmProvider =
    selectedModelArg === undefined ? 'ollama' : providerOrSelectedModel as LlmProvider
  const selectedModel = selectedModelArg ?? providerOrSelectedModel
  if (isOpenAiImageGenModel(selectedModel)) {
    return false
  }
  if (modelIsImageGen(selectedModel)) {
    return false
  }
  return (await listAvailableImageModels()).length > 0
}

export function generateImageToolDefinition(): OllamaTool {
  return {
    type: 'function',
    function: {
      name: GENERATE_IMAGE_NAME,
      description:
        'Generate an actual image from a text prompt, or edit supplied source images, using the configured image model. Use this only when the user wants an image created or edited. Do not use it for writing image prompts, describing scenes, or suggesting image ideas.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Full image-generation prompt'
          },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional source images as base64 payloads for editing'
          }
        },
        required: ['prompt']
      }
    }
  }
}

export type GenerateImageToolResult =
  | { ok: true; model: string; imageBase64: string; message: string }
  | { ok: false; message: string }

export async function runGenerateImageTool(
  provider: LlmProvider,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<GenerateImageToolResult> {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) {
    return { ok: false, message: 'Missing required argument: prompt' }
  }

  let images: string[] | undefined
  if (args.images !== undefined) {
    if (
      !Array.isArray(args.images) ||
      args.images.some((image) => typeof image !== 'string' || image.length === 0)
    ) {
      return { ok: false, message: 'Source images must be non-empty strings' }
    }
    images = [...new Set(args.images)]
  }

  try {
    const backend = resolveImageBackend(
      getDefaultImageModel(),
      await listAvailableImageModels(),
      provider
    )
    if (!backend) {
      return {
        ok: false,
        message:
          'No image models installed. Install an image model to generate images.'
      }
    }

    if (images && images.length > 0 && backend.provider === 'ollama') {
      return {
        ok: false,
        message:
          'Image editing requires an OpenAI image model. Select an OpenAI image model and try again.'
      }
    }

    const imageBase64 =
      backend.provider === 'openai'
        ? (await (images && images.length > 0
            ? editOpenAiImageBase64(backend.model, prompt, images, signal)
            : generateOpenAiImageBase64(backend.model, prompt, signal))).b64
        : await generateImageBase64(backend.model, prompt, signal)
    return {
      ok: true,
      model: backend.model,
      imageBase64,
      message: `Generated image with ${backend.model} via ${backend.provider}`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message }
  }
}
