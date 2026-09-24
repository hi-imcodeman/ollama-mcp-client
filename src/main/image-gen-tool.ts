import {
  getDefaultImageModel,
  getOpenaiModelEnabledMap,
  getOpenaiModelsCatalog
} from './config-store'
import { isOpenAiImageGenModel } from '../shared/openai-models'
import type { LlmProvider } from '../shared/types'
import { generateImageBase64 } from './ollama-image'
import { generateOpenAiImageBase64 } from './openai-image'
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

export async function listInstalledImageModelNames(): Promise<string[]> {
  const models = await listModels()
  return models
    .filter((m) => modelIsImageGen(m.name, { capabilities: m.capabilities }))
    .map((m) => m.name)
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
  if (provider === 'ollama') {
    const status = await getOllamaStatus()
    if (!status.ok || status.imageGenSupported === false) return false
    try {
      const models = await listModels()
      const selected = models.find((m) => m.name === selectedModel)
      if (modelIsImageGen(selectedModel, { capabilities: selected?.capabilities })) {
        return false
      }
      return models.some((m) =>
        modelIsImageGen(m.name, { capabilities: m.capabilities })
      )
    } catch {
      return false
    }
  }

  const available = await listAvailableImageModelNames(provider)
  if (isOpenAiImageGenModel(selectedModel)) return false
  return (
    !isImageModelAvailable(provider, selectedModel, available) &&
    available.length > 0
  )
}

export function generateImageToolDefinition(): OllamaTool {
  return {
    type: 'function',
    function: {
      name: GENERATE_IMAGE_NAME,
      description:
        'Generate an image from a text prompt using the configured image model. Call this when the user asks you to create, draw, or generate an image. Write a detailed prompt in the prompt argument.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Full image-generation prompt'
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

  try {
    const imageNames = await listAvailableImageModelNames(provider)
    const model = resolveImageModelForProvider(
      provider,
      getDefaultImageModel(),
      imageNames
    )
    if (!model) {
      return {
        ok: false,
        message:
          'No image models installed. Install an image model to generate images.'
      }
    }

    const imageBase64 =
      provider === 'openai'
        ? (await generateOpenAiImageBase64(model, prompt, signal)).b64
        : await generateImageBase64(model, prompt, signal)
    return {
      ok: true,
      model,
      imageBase64,
      message: `Generated image with ${model}`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message }
  }
}
