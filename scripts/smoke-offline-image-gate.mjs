#!/usr/bin/env node
/**
 * Smoke check: shouldOfferGenerateImageTool guard logic when Ollama is unreachable.
 * Mirrors the guards in src/main/image-gen-tool.ts without Electron deps.
 */

async function fetchOllamaStatus(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000)
    })
    if (!res.ok) return { ok: false, baseUrl }
    return { ok: true, baseUrl, imageGenSupported: true }
  } catch {
    return { ok: false, baseUrl }
  }
}

async function shouldOfferLike(status, listModelsFn, selectedModel = 'llama3') {
  if (!status.ok) return false
  if (status.imageGenSupported === false) return false
  let models
  try {
    models = await listModelsFn()
  } catch {
    return false
  }
  const selected = models.find((m) => m.name === selectedModel)
  const isImage = (name, caps) =>
    caps?.includes?.('image') || /flux|stable|image/i.test(name)
  if (isImage(selectedModel, selected?.capabilities)) return false
  return models.some((m) => isImage(m.name, m.capabilities))
}

let failed = 0

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  } else {
    console.log(`PASS: ${msg}`)
  }
}

const deadUrl = 'http://127.0.0.1:59999'
const status = await fetchOllamaStatus(deadUrl)
assert(status.ok === false, `dead port ${deadUrl} yields ok=false`)

const offerWhenOffline = await shouldOfferLike(status, () => {
  throw new Error('listModels must not be called when offline')
})
assert(offerWhenOffline === false, 'offline status returns false without calling listModels')

const offerWhenListFails = await shouldOfferLike(
  { ok: true, imageGenSupported: true },
  () => {
    throw new Error('connection refused')
  }
)
assert(offerWhenListFails === false, 'listModels failure returns false')

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll offline gating smoke checks passed')
