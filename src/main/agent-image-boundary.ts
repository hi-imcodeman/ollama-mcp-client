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

  return {
    ...args,
    images: [...new Set(currentTurnImages)]
  }
}

export function prepareEditImageToolArguments(messages: ChatMessage[]): string[] {
  const currentUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user')
  return Array.isArray(currentUserMessage?.images)
    ? [...new Set(currentUserMessage.images)]
    : []
}
