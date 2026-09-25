import type { ChatMessage } from '../shared/types'

export interface EditImageSource {
  base64: string
  mime?: string
}

export function prepareGenerateImageToolArguments(
  messages: ChatMessage[],
  args: Record<string, unknown>
): Record<string, unknown> {
  const currentUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user')
  const currentTurnImages = Array.isArray(currentUserMessage?.images)
    ? currentUserMessage.images
    : []

  if (currentTurnImages.length === 0) return args

  return {
    ...args,
    images: [...new Set(currentTurnImages)]
  }
}

export function prepareEditImageToolArguments(
  messages: ChatMessage[],
  latestGeneratedImage?: string
): Array<string | EditImageSource> {
  return selectEditImageSources(messages, latestGeneratedImage)
}

export function selectEditImageSources(
  messages: ChatMessage[],
  latestGeneratedImage?: string
): Array<string | EditImageSource> {
  const currentUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user')
  const currentTurnImages = Array.isArray(currentUserMessage?.images)
    ? [...new Set(currentUserMessage.images)].map((base64) => {
        const index = currentUserMessage.images?.indexOf(base64) ?? -1
        const mime = currentUserMessage.imageMimes?.[index]
        return mime ? { base64, mime } : base64
      })
    : []

  if (currentTurnImages.length > 0) return currentTurnImages
  return latestGeneratedImage ? [latestGeneratedImage] : []
}
