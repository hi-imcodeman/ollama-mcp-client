import type { ChatMessage } from '../shared/types'

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

  const modelImages = Array.isArray(args.images) ? args.images : []
  return {
    ...args,
    images: [...new Set([...modelImages, ...currentTurnImages])]
  }
}
