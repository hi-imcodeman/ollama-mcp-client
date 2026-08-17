/**
 * Models often indent reasoning/lists with 4+ spaces. CommonMark treats that as
 * a code block, so bullets show up as literal "* …" in a monospace box.
 * Also sanitize currency symbols inside $math$ that KaTeX cannot render (e.g. ₹).
 * llama.cpp byte-fallback tokens (`<0xF0><0x9F>…`) are decoded to UTF-8.
 */
export function normalizeMarkdown(source: string): string {
  const text = decodeByteFallbackTokens(source.replace(/\r\n/g, '\n'))
  if (!text.trim()) return source

  const lines = text.split('\n')
  const nonEmpty = lines.filter((l) => l.trim().length > 0)
  const minIndent = Math.min(...nonEmpty.map(leadingWidth))

  const dedented =
    minIndent > 0
      ? lines.map((l) => (l.trim() ? stripWidth(l, minIndent) : l))
      : lines

  // Paragraphs at column 0 + lists indented 4+ still become code blocks.
  const unindentedLists = dedented
    .map((line) => {
      const match = /^(?<indent>[ \t]+)(?<marker>[-*+]|\d+\.)(?<gap>\s+)(?<rest>.*)$/.exec(
        line
      )
      if (!match?.groups) return line
      if (leadingWidth(match.groups.indent) < 4) return line
      return `${match.groups.marker}${match.groups.gap}${match.groups.rest}`
    })
    .join('\n')

  return sanitizeMathCurrency(unindentedLists)
}

/** KaTeX has no glyph metrics for many currency symbols (₹, etc.). */
const MATH_CURRENCY_REPLACEMENTS: Array<[string, string]> = [
  ['₹', '\\text{Rs.}'],
  ['€', '\\euro'],
  ['£', '\\pounds'],
  ['¥', '\\yen']
]

const BYTE_FALLBACK_RUN = /(?:<0x[0-9A-Fa-f]{2}>)+/g
const BYTE_FALLBACK_BYTE = /<0x([0-9A-Fa-f]{2})>/gi

/**
 * llama.cpp emits unknown UTF-8 as hex tokens instead of the character.
 * Decode consecutive runs; leave incomplete trailing bytes as-is for streaming.
 */
function decodeByteFallbackTokens(source: string): string {
  return source.replace(BYTE_FALLBACK_RUN, (run) => {
    const bytes = [...run.matchAll(BYTE_FALLBACK_BYTE)].map((m) =>
      parseInt(m[1], 16)
    )
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let validLen = bytes.length
    while (validLen > 0) {
      try {
        const decoded = decoder.decode(new Uint8Array(bytes.slice(0, validLen)))
        return decoded + formatByteTokens(bytes.slice(validLen))
      } catch {
        validLen -= 1
      }
    }
    return run
  })
}

function formatByteTokens(bytes: number[]): string {
  return bytes
    .map((b) => `<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`)
    .join('')
}

function sanitizeMathCurrency(source: string): string {
  let out = source.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => {
    return `$$${replaceCurrencyInMath(body)}$$`
  })
  out = out.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (_m, body: string) => {
    return `$${replaceCurrencyInMath(body)}$`
  })
  return out
}

function replaceCurrencyInMath(body: string): string {
  let next = body
  for (const [char, repl] of MATH_CURRENCY_REPLACEMENTS) {
    if (next.includes(char)) next = next.split(char).join(repl)
  }
  return next
}

function leadingWidth(line: string): number {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width += 1
    else if (ch === '\t') width += 4
    else break
  }
  return width
}

function stripWidth(line: string, width: number): string {
  let left = width
  let i = 0
  while (i < line.length && left > 0) {
    const ch = line[i]
    if (ch === ' ') {
      left -= 1
      i += 1
    } else if (ch === '\t') {
      left -= 4
      i += 1
    } else {
      break
    }
  }
  return line.slice(i)
}
