/** Architecture max (e.g. llama.context_length = 131072) is not the live window. */

/** Ollama's documented default when no num_ctx / app slider / env is set. */
export const OLLAMA_DEFAULT_NUM_CTX = 4096

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.round(n)
}

export function parseArchitectureContextMax(
  modelInfo?: Record<string, unknown> | null
): number | undefined {
  if (!modelInfo) return undefined
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!/context_length$/i.test(key)) continue
    const n = positiveInt(value)
    if (n) return n
  }
  return undefined
}

export function parseNumCtx(
  parameters?: string | null,
  modelfile?: string | null
): number | undefined {
  const fromParams = parameters?.match(/num_ctx\s+(\d+)/i)
  if (fromParams) {
    const n = positiveInt(fromParams[1])
    if (n) return n
  }
  const fromFile = modelfile?.match(/parameter\s+num_ctx\s+(\d+)/i)
  if (fromFile) {
    const n = positiveInt(fromFile[1])
    if (n) return n
  }
  return undefined
}

/**
 * Live window is the minimum of Ollama's configured context (app slider,
 * OLLAMA_CONTEXT_LENGTH, Modelfile num_ctx, or the 4k default) and the
 * model's architecture maximum. Never treat the architecture max as the
 * configured window.
 */
export function parseContextLength(
  modelInfo?: Record<string, unknown> | null,
  parameters?: string | null,
  modelfile?: string | null,
  runningContext?: number | null,
  serverContext?: number | null
): number | undefined {
  const archMax = parseArchitectureContextMax(modelInfo)
  const numCtx = parseNumCtx(parameters, modelfile)
  const server = positiveInt(serverContext)
  let running = positiveInt(runningContext)
  // /api/ps context_length is often the architecture max, not num_ctx.
  if (running && archMax && running >= archMax && !numCtx) {
    running = undefined
  }

  const configured =
    numCtx ?? running ?? server ?? OLLAMA_DEFAULT_NUM_CTX
  if (archMax) return Math.min(configured, archMax)
  return configured
}
