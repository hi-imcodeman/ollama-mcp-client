# Chat Model Image Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a chat model is selected, expose a built-in `generate_image` tool that runs a Settings-configured (or auto-picked) image model and shows the result via existing `assistant_images` events.

**Architecture:** Mirror `load_skill`: a small `image-gen-tool.ts` module owns tool schema, gating, and default-model resolution. The agent injects the tool only for non-image chat models when Ollama supports image gen and at least one image model is installed. Tool execution reuses `generateImageBase64` and emits `assistant_images`. Config adds `defaultImageModel`; Settings exposes an Auto + image-model picker.

**Tech Stack:** TypeScript, Electron main/preload/renderer, existing Ollama HTTP client (`ollama.ts`, `ollama-image.ts`), React Settings UI, `electron-store`

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-07-chat-model-image-tool-design.md`
- Built-in tool name exactly `generate_image`; required arg `prompt: string`
- `defaultImageModel: string | null` — `null` means Auto (first installed image-capable model)
- Do not expose the tool when: selected model is image-gen, Ollama `imageGenSupported` is false, or no image models installed
- Image model selected in chat dropdown keeps today’s direct `/api/generate` path unchanged
- Do not put raw base64 in the tool result text for the model; images only via `assistant_images`
- No extra generation params (size, seed, steps)
- Do not remove image models from the chat dropdown
- No new test runner — verify with `npm run typecheck` + manual checks from the spec
- Applies to all agent entry points (desktop, Telegram, schedules) via shared `runAgentTurn`

---

## File map

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` | `defaultImageModel` on `AppConfig` |
| `src/main/config-store.ts` | Persist get/set `defaultImageModel` |
| `src/main/image-gen-tool.ts` | Tool name, schema, gating, resolve default, run generation |
| `src/main/agent.ts` | Inject tool + dispatch handler; emit images |
| `src/main/ipc.ts` | `config:setDefaultImageModel`; clear stale default on model delete |
| `src/preload/index.ts` | `setDefaultImageModel` bridge |
| `src/renderer/src/components/Settings.tsx` | Default image model picker under Chat |
| `src/renderer/src/App.tsx` | Load/save config + pass models into Settings |

---

### Task 1: Config + pure resolve helpers

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/config-store.ts`
- Create: `src/main/image-gen-tool.ts`

**Interfaces:**
- Produces: `AppConfig.defaultImageModel`, `getDefaultImageModel()`, `setDefaultImageModel(model: string | null)`, `GENERATE_IMAGE_NAME`, `resolveDefaultImageModel(configured, imageModelNames)`, `listInstalledImageModelNames()`, `shouldOfferGenerateImageTool(selectedModel)`, `generateImageToolDefinition()`, `runGenerateImageTool(args, signal)`

- [ ] **Step 1: Add `defaultImageModel` to `AppConfig`**

In `src/shared/types.ts`, inside `AppConfig`:

```ts
  /** Preferred image model for generate_image tool; null = Auto (first installed). */
  defaultImageModel: string | null
```

- [ ] **Step 2: Persist in `config-store.ts`**

Add to `DEFAULT_CONFIG`:

```ts
  defaultImageModel: null,
```

In `getConfig()`, include:

```ts
    defaultImageModel: store.get('defaultImageModel', DEFAULT_CONFIG.defaultImageModel),
```

Add:

```ts
export function getDefaultImageModel(): string | null {
  return store.get('defaultImageModel', DEFAULT_CONFIG.defaultImageModel)
}

export function setDefaultImageModel(model: string | null): string | null {
  const value = model && model.trim() ? model.trim() : null
  store.set('defaultImageModel', value)
  return value
}
```

- [ ] **Step 3: Create `src/main/image-gen-tool.ts`**

```ts
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
  if (status.imageGenSupported === false) return false
  const models = await listModels()
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
```

- [ ] **Step 4: Sanity-check resolve helper in a one-off node eval (optional) or mental check**

Cases:
- `resolveDefaultImageModel(null, ['a', 'b'])` → `'a'`
- `resolveDefaultImageModel('b', ['a', 'b'])` → `'b'`
- `resolveDefaultImageModel('gone', ['a'])` → `'a'`
- `resolveDefaultImageModel(null, [])` → `null`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`  
Expected: PASS (or only pre-existing unrelated errors)

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/config-store.ts src/main/image-gen-tool.ts
git commit -m "$(cat <<'EOF'
Add defaultImageModel config and generate_image tool helpers.

EOF
)"
```

---

### Task 2: IPC + preload

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `setDefaultImageModel`, `getDefaultImageModel` from config-store
- Produces: `config:setDefaultImageModel` IPC; `window.api.setDefaultImageModel`

- [ ] **Step 1: Register IPC in `src/main/ipc.ts`**

Import `setDefaultImageModel` (and `getDefaultImageModel` if needed) from `./config-store`.

Add handler next to max tool iterations:

```ts
  ipcMain.handle('config:setDefaultImageModel', (_e, model: string | null) =>
    setDefaultImageModel(model)
  )
```

In the existing `ollama:deleteModel` handler, after clearing `selectedModel` when deleted, also clear a matching default:

```ts
    const defaultImage = getDefaultImageModel()
    if (defaultImage === model) {
      setDefaultImageModel(null)
    }
```

(Import `getDefaultImageModel` / `setDefaultImageModel` as needed.)

- [ ] **Step 2: Expose preload API in `src/preload/index.ts`**

Next to `setMaxToolIterations`:

```ts
  setDefaultImageModel: (model: string | null): Promise<string | null> =>
    ipcRenderer.invoke('config:setDefaultImageModel', model),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "$(cat <<'EOF'
Wire defaultImageModel IPC and preload API.

EOF
)"
```

---

### Task 3: Agent — inject tool and handle calls

**Files:**
- Modify: `src/main/agent.ts`

**Interfaces:**
- Consumes: `GENERATE_IMAGE_NAME`, `shouldOfferGenerateImageTool`, `generateImageToolDefinition`, `runGenerateImageTool`
- Produces: tool list includes `generate_image` when gated; tool calls emit `assistant_images` + text tool result

- [ ] **Step 1: Import helpers**

```ts
import {
  GENERATE_IMAGE_NAME,
  generateImageToolDefinition,
  runGenerateImageTool,
  shouldOfferGenerateImageTool
} from './image-gen-tool'
```

- [ ] **Step 2: Build tools after image-gen early return is known**

Replace the current sync tool list construction so image-tool gating runs only on the **chat** path (after the `modelIsImageGen` early return block). Move or duplicate carefully:

Today (near turn start):

```ts
  const skillTool = loadSkillTool()
  const tools = [...(skillTool ? [skillTool] : []), ...toolsFromMcp()]
```

Change to: keep skills+MCP at the top for logging if desired, but **after** confirming `!modelIsImageGen(...)`, rebuild/extend tools:

```ts
  const skillTool = loadSkillTool()
  const baseTools = [...(skillTool ? [skillTool] : []), ...toolsFromMcp()]
  // ... image-gen early return uses payload.model and never needs generate_image ...

  const offerImageTool = await shouldOfferGenerateImageTool(payload.model)
  const tools = offerImageTool
    ? [...baseTools, generateImageToolDefinition()]
    : baseTools
```

Place `offerImageTool` / final `tools` **after** the image-gen early-return block so direct image mode is unchanged and does not list the tool. Ensure the later chat loop uses this `tools` variable (move the initial construction if the early return currently sits after tools are built — reorder so direct image path still works and chat path gets the gated list).

Concrete order inside `runAgentTurn`:

1. Abort/turn setup, `emitTurn` helpers  
2. `getModelInfo` / `contextLimit`  
3. If `modelIsImageGen` → existing direct generate path → return  
4. `skillTool` + MCP tools + optional `generate_image`  
5. Rest of chat/tool loop  

- [ ] **Step 3: Dispatch in the tool-call loop**

Where tools are executed (today `load_skill` vs `mcpManager.callTool`), extend:

```ts
        let ok: boolean
        let result: string
        if (tc.name === LOAD_SKILL_NAME) {
          ;({ ok, result } = loadSkillByName(String(tc.arguments.name ?? '')))
        } else if (tc.name === GENERATE_IMAGE_NAME) {
          emitTurn({
            type: 'status',
            phase: 'generating',
            detail: 'Generating image…'
          })
          const gen = await runGenerateImageTool(tc.arguments, abort.signal)
          if (gen.ok) {
            emitTurn({
              type: 'assistant_images',
              images: [gen.imageBase64],
              mime: 'image/png'
            })
            ok = true
            result = gen.message
          } else {
            ok = false
            result = gen.message
          }
        } else {
          ;({ ok, result } = await mcpManager.callTool(tc.name, tc.arguments))
        }
```

Keep existing `tool_start` / `tool_result` emits around this so the UI still shows a tool card. Do not include base64 in `result`.

If abort happened during generation, `runGenerateImageTool` returns `ok: false`; existing abort checks after the tool loop still apply.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`  
Expected: PASS

- [ ] **Step 5: Manual smoke (dev)**

1. Chat model selected, image model installed → ask “draw a blue square” → tool card + image in transcript.  
2. Select image model in dropdown → still direct generate (no `generate_image` tool).  

- [ ] **Step 6: Commit**

```bash
git add src/main/agent.ts
git commit -m "$(cat <<'EOF'
Inject generate_image tool into agent chat turns.

EOF
)"
```

---

### Task 4: Settings UI + App wiring

**Files:**
- Modify: `src/renderer/src/components/Settings.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `window.api.setDefaultImageModel`, `config.defaultImageModel`, `models`, `imageGenSupported`
- Produces: Settings picker for Auto + image models

- [ ] **Step 1: Extend `Settings` props**

```ts
import type { OllamaModel, TelegramStatus } from '../../../shared/types'

interface SettingsProps {
  // ...existing...
  maxToolIterations: number
  defaultImageModel: string | null
  models: OllamaModel[]
  imageGenSupported: boolean
  onSetMaxToolIterations: (value: number) => void
  onSetDefaultImageModel: (model: string | null) => void
}
```

Destructure the new props.

Helper inside the component (or inline):

```ts
  const imageModels = models.filter(
    (m) =>
      m.tags?.some((t) => t.toLowerCase() === 'image') ||
      m.capabilities?.some((c) => c.toLowerCase() === 'image') ||
      /z-image|flux|sdxl|stable-diffusion|stable_diffusion|imagen|dreamshaper|animagine/i.test(
        m.name
      )
  )
```

- [ ] **Step 2: Add Chat section UI after Max tool iterations**

```tsx
            <label className="mt-3 block">
              <span className="mb-1 block text-sm text-[#e7ecf1]">Default image model</span>
              <span className="mb-2 block text-xs text-[#6b7a8c]">
                Used when a chat model calls generate_image. Auto picks the first installed
                image model.
              </span>
              {!imageGenSupported ? (
                <p className="text-xs text-amber-300/90">
                  This Ollama build does not support image generation.
                </p>
              ) : imageModels.length === 0 ? (
                <p className="text-xs text-[#6b7a8c]">
                  No image models installed — image generation disabled until you install one.
                </p>
              ) : (
                <select
                  value={defaultImageModel ?? ''}
                  onChange={(e) =>
                    onSetDefaultImageModel(e.target.value === '' ? null : e.target.value)
                  }
                  className="w-full rounded border border-[#2a3a4d] bg-[#121820] px-2 py-1.5 text-sm text-[#e7ecf1] outline-none focus:border-[#4a7ab0]"
                >
                  <option value="">Auto (first available)</option>
                  {imageModels.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
```

- [ ] **Step 3: Wire `App.tsx`**

State:

```ts
  const [defaultImageModel, setDefaultImageModel] = useState<string | null>(null)
```

On config load (where `maxToolIterations` is set):

```ts
      setDefaultImageModel(config.defaultImageModel ?? null)
```

Handler:

```ts
  const handleSetDefaultImageModel = async (model: string | null): Promise<void> => {
    const saved = await window.api.setDefaultImageModel(model)
    setDefaultImageModel(saved)
  }
```

Pass into `<Settings />`:

```tsx
            defaultImageModel={defaultImageModel}
            models={models}
            imageGenSupported={imageGenSupported}
            onSetDefaultImageModel={handleSetDefaultImageModel}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`  
Expected: PASS

- [ ] **Step 5: Manual Settings check**

Open Settings → Chat → Default image model shows Auto + image models; saving persists across reload.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Settings.tsx src/renderer/src/App.tsx
git commit -m "$(cat <<'EOF'
Add Settings picker for default image model.

EOF
)"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run typecheck once more**

Run: `npm run typecheck`  
Expected: PASS

- [ ] **Step 2: Manual checklist (from spec)**

1. Chat model + ≥1 image model, default Auto → ask to draw something → tool runs, image appears, optional caption.  
2. Pin a specific default image model in Settings → request uses that model (visible in tool result text).  
3. With no image models (or temporarily rename filter by testing gating) → tool absent; text-only reply.  
4. Select an image model in the dropdown → direct prompt→image (no tool card).  
5. Abort mid-generation → tool fails cleanly; turn ends without hang.  
6. If Telegram enabled: same behavior from a Telegram chat with a chat model.

- [ ] **Step 3: Final commit only if verification fixed anything; otherwise done**

If fixes were needed, commit them with a clear message. If clean, no empty commit.

---

## Spec coverage checklist

| Spec requirement | Task |
| --- | --- |
| Built-in `generate_image` tool | Task 1 + 3 |
| `defaultImageModel` config + Auto fallback | Task 1 |
| Gate: no image models / unsupported Ollama / image model selected | Task 1 `shouldOffer…` + Task 3 |
| Direct image-model path unchanged | Task 3 ordering |
| Emit `assistant_images`, short text tool result | Task 3 |
| Settings picker under Chat | Task 4 |
| IPC/preload | Task 2 |
| Clear stale default on model delete | Task 2 |
| Desktop + Telegram + schedules via agent | Task 3 (shared `runAgentTurn`) |
| Manual test plan | Task 5 |
