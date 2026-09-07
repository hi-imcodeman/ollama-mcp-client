import { getDefaultImageModel } from './config-store'
import { generateImageBase64 } from './ollama-image'
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

export async function listInstalledImageModelNames(): Promise<string[]> {
  const models = await listModels()
  return models
    .filter((m) => modelIsImageGen(m.name, { capabilities: m.capabilities }))
    .map((m) => m.name)
}

export async function shouldOfferGenerateImageTool(
  selectedModel: string
): Promise<boolean> {
  const status = await getOllamaStatus()
  if (!status.ok) return false
  if (status.imageGenSupported === false) return false
  let models
  try {
    models = await listModels()
  } catch {
    return false
  }
  const selected = models.find((m) => m.name === selectedModel)
  if (modelIsImageGen(selectedModel, { capabilities: selected?.capabilities })) {
    return false
  }
  return models.some((m) =>
    modelIsImageGen(m.name, { capabilities: m.capabilities })
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
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<GenerateImageToolResult> {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) {
    return { ok: false, message: 'Missing required argument: prompt' }
  }
  const imageNames = await listInstalledImageModelNames()
  const model = resolveDefaultImageModel(getDefaultImageModel(), imageNames)
  if (!model) {
    return {
      ok: false,
      message: 'No image models installed. Install an image model to generate images.'
    }
  }
  try {
    const imageBase64 = await generateImageBase64(model, prompt, signal)
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
