export type ChatAttachmentKind = 'image' | 'text' | 'other'

export interface ChatAttachment {
  id: string
  name: string
  mime: string
  size: number
  kind: ChatAttachmentKind
  /** Data URL for image preview */
  previewUrl?: string
  /** Raw base64 without data-URL prefix (images for Ollama) */
  imageBase64?: string
  /** Inlined text file contents */
  textContent?: string
}

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp'
])

const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|js|jsx|ts|tsx|mjs|cjs|css|scss|html|htm|xml|yml|yaml|toml|ini|env|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|sql|graphql|vue|svelte|log|conf|cfg|gitignore|dockerignore|dockerfile)$/i

const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_EDGE = 1280

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsText(file)
  })
}

function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',')
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = dataUrl
  })
}

/** Resize + JPEG-encode so Ollama gets a reliable, reasonably sized payload. */
async function optimizeImageForOllama(file: File): Promise<{
  previewUrl: string
  imageBase64: string
}> {
  const original = await readAsDataUrl(file)
  const img = await loadImageElement(original)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height))
  const width = Math.max(1, Math.round(img.width * scale))
  const height = Math.max(1, Math.round(img.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return {
      previewUrl: original,
      imageBase64: stripDataUrlPrefix(original)
    }
  }
  ctx.drawImage(img, 0, 0, width, height)
  const jpegUrl = canvas.toDataURL('image/jpeg', 0.85)
  return {
    previewUrl: original,
    imageBase64: stripDataUrlPrefix(jpegUrl)
  }
}

function detectKind(file: File): ChatAttachmentKind {
  if (IMAGE_TYPES.has(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
    return 'image'
  }
  if (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    file.type === 'application/xml' ||
    TEXT_EXT.test(file.name)
  ) {
    return 'text'
  }
  return 'other'
}

export async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const kind = detectKind(file)
  const base: ChatAttachment = {
    id: crypto.randomUUID(),
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    kind
  }

  if (kind === 'image') {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`${file.name} is too large (max 15 MB for images)`)
    }
    const optimized = await optimizeImageForOllama(file)
    if (!optimized.imageBase64 || optimized.imageBase64.length < 32) {
      throw new Error(`${file.name}: failed to encode image data`)
    }
    return {
      ...base,
      mime: 'image/jpeg',
      previewUrl: optimized.previewUrl,
      imageBase64: optimized.imageBase64
    }
  }

  if (kind === 'text') {
    if (file.size > MAX_TEXT_BYTES) {
      throw new Error(`${file.name} is too large (max 2 MB for text files)`)
    }
    const textContent = await readAsText(file)
    return { ...base, textContent }
  }

  throw new Error(
    `${file.name}: unsupported file type. Attach images or text/code files.`
  )
}

export function buildMessageFromAttachments(
  prompt: string,
  attachments: ChatAttachment[]
): {
  content: string
  images?: string[]
  displayImages?: string[]
  labels: string[]
} {
  const parts: string[] = []
  const trimmed = prompt.trim()
  if (trimmed) parts.push(trimmed)

  const images: string[] = []
  const displayImages: string[] = []
  const labels: string[] = []

  for (const file of attachments) {
    labels.push(file.name)
    if (file.kind === 'image' && file.imageBase64) {
      images.push(file.imageBase64)
      if (file.previewUrl) displayImages.push(file.previewUrl)
      continue
    }
    if (file.kind === 'text' && file.textContent !== undefined) {
      const fence = file.name.includes('`') ? '~~~' : '```'
      parts.push(
        `Attached file: ${file.name}\n${fence}${guessFenceLang(file.name)}\n${file.textContent}\n${fence}`
      )
    }
  }

  const content = parts.join('\n\n')

  return {
    content,
    images: images.length ? images : undefined,
    displayImages: displayImages.length ? displayImages : undefined,
    labels
  }
}

function guessFenceLang(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    py: 'python',
    md: 'md',
    json: 'json',
    css: 'css',
    html: 'html',
    sh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    rs: 'rust',
    go: 'go',
    sql: 'sql'
  }
  return map[ext] ?? ''
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
