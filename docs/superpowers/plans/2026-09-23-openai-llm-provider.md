# OpenAI LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users enable OpenAI, validate an API key, enable models on the Models page, choose Ollama vs OpenAI as LLM provider, and run the full MCP agent (streaming, tools, Telegram, schedules) through OpenAI Chat Completions with Ollama fallback when OpenAI is unavailable.

**Architecture:** Add config fields and OpenAI HTTP client in main process; introduce `LlmProvider` interface with Ollama and OpenAI adapters; refactor `agent.ts` and related callers to resolve effective provider per turn; extend Settings and Models page UI; chat dropdown lists provider-appropriate models (OpenAI = enabled only).

**Tech Stack:** Electron, electron-store, TypeScript, React 19, fetch to OpenAI `/v1/models` and `/v1/chat/completions` (SSE).

## Global Constraints

- Default `llmProvider`: `'ollama'`; default `openaiEnabled`: `false`.
- Runtime fallback to Ollama when configured provider is OpenAI but OpenAI is disabled, missing key, or validation failed — show warning; do not change stored `llmProvider`.
- Per-provider selected models: `selectedModelByProvider.ollama` and `.openai`.
- After key validation or refresh: fetch all chat-relevant models; **new models default disabled**; only enabled models in chat dropdown.
- OpenAI image generation (DALL·E) out of scope v1; Ollama image-gen unchanged on Ollama path.
- API key and OpenAI HTTP only in main process.
- Run `npm run typecheck` after each task; manual tests from spec checklist where noted.

---

## File map

| File | Role |
| --- | --- |
| `src/shared/types.ts` | New config/types, `OpenAiStatus`, catalog entry |
| `src/main/config-store.ts` | Persist, migrate, getters/setters |
| `src/main/llm/effective-provider.ts` | `resolveEffectiveLlmProvider()` |
| `src/main/llm/types.ts` | Provider interface + shared result types |
| `src/main/llm/ollama-provider.ts` | Wrap `ollama.ts` exports |
| `src/main/openai-client.ts` | Validate, list models, chat stream/once |
| `src/main/llm/openai-provider.ts` | `LlmProvider` for OpenAI |
| `src/main/llm/index.ts` | `getLlmProvider()`, registry |
| `src/main/ipc.ts` | New IPC handlers |
| `src/preload/index.ts`, `index.d.ts` | Expose API |
| `src/main/agent.ts` | Provider routing |
| `src/main/session-title.ts`, `context-compact.ts`, `schedule-executor.ts` | Provider routing |
| `src/renderer/src/components/Settings.tsx` | Provider + OpenAI UI |
| `src/renderer/src/components/ModelsPage.tsx` | OpenAI enable toggles |
| `src/renderer/src/components/Chat.tsx` | Dropdown + fallback banner |
| `src/renderer/src/App.tsx` | State wiring for new config |

---

### Task 1: Shared types and config store

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/config-store.ts`

**Interfaces:**
- Produces: `LlmProvider`, `OpenAiModelEntry`, extended `AppConfig`, `OpenAiStatus`, helpers on config-store listed below.

- [ ] **Step 1: Add types to `types.ts`**

```ts
export type LlmProvider = 'ollama' | 'openai'

export interface OpenAiModelEntry {
  id: string
  ownedBy?: string
  created?: number
}

export interface OpenAiStatus {
  enabled: boolean
  validationOk: boolean
  validationError: string | null
  catalogCount: number
  enabledCount: number
}

// Extend AppConfig with:
// llmProvider, openaiEnabled, openaiApiKey, openaiValidationOk,
// openaiValidationError, openaiModelsCatalog, openaiModelEnabled,
// selectedModelByProvider
```

- [ ] **Step 2: Defaults and migration in `config-store.ts`**

Add to `DEFAULT_CONFIG`. Implement:

- `getLlmProvider` / `setLlmProvider`
- `getOpenaiEnabled` / `setOpenaiEnabled`
- `getOpenaiApiKey` / `setOpenaiApiKey`
- `getOpenaiValidationState` / `setOpenaiValidationOk(error?: string | null)`
- `getOpenaiModelsCatalog` / `setOpenaiModelsCatalog`
- `getOpenaiModelEnabledMap` / `setOpenaiModelEnabled(id, enabled)` / `mergeOpenaiCatalog(entries)` — merge sets new ids to disabled, prunes stale enabled keys, removes selection if model gone
- `getSelectedModelByProvider` / `setSelectedModelForProvider(provider, model)`
- Update `getConfig()` to include all fields; migrate legacy `selectedModel` → `selectedModelByProvider.ollama` on read

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`  
Expected: PASS (fix any `AppConfig` spread sites)

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/main/config-store.ts
git commit -m "feat: add OpenAI provider config schema and store helpers"
```

---

### Task 2: OpenAI client (validate + list)

**Files:**
- Create: `src/main/openai-client.ts`

**Interfaces:**
- Consumes: `getOpenaiApiKey()` from config-store
- Produces: `validateOpenAiKey(): Promise<{ ok: boolean; error?: string }>`, `fetchOpenAiChatModels(): Promise<OpenAiModelEntry[]>`, `isChatModelId(id: string): boolean`

- [ ] **Step 1: Implement HTTP helpers**

```ts
const OPENAI_BASE = 'https://api.openai.com/v1'

export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase()
  if (lower.startsWith('text-embedding-')) return false
  if (lower.startsWith('whisper-')) return false
  if (lower.startsWith('tts-')) return false
  if (lower.startsWith('dall-e-')) return false
  if (lower.includes('realtime')) return false
  return true
}

export async function fetchOpenAiModels(apiKey: string): Promise<OpenAiModelEntry[]> {
  const res = await fetch(`${OPENAI_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  const data = (await res.json()) as { data?: Array<{ id: string; owned_by?: string; created?: number }> }
  return (data.data ?? [])
    .filter((m) => isChatModelId(m.id))
    .map((m) => ({ id: m.id, ownedBy: m.owned_by, created: m.created }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function validateOpenAiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await fetchOpenAiModels(apiKey)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:node`  
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/openai-client.ts
git commit -m "feat: add OpenAI models list and key validation client"
```

---

### Task 3: Effective provider + IPC for config/OpenAI

**Files:**
- Create: `src/main/llm/effective-provider.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`, `src/preload/index.d.ts`

**Interfaces:**
- Produces: `resolveEffectiveLlmProvider(): { effective: LlmProvider; configured: LlmProvider; fallback: boolean; reason?: string }`, `getOpenAiStatus(): OpenAiStatus`
- IPC: `openai:validateAndFetchModels`, `openai:refreshModels`, `config:setLlmProvider`, `config:setOpenaiEnabled`, `config:setOpenaiApiKey`, `config:setOpenaiModelEnabled`, `config:setSelectedModelForProvider`, `llm:getEffectiveProvider`

- [ ] **Step 1: Implement `effective-provider.ts`**

Use config getters; return fallback reason strings suitable for UI.

- [ ] **Step 2: Wire IPC handlers**

`validateAndFetchModels`: read key, validate, on success `mergeOpenaiCatalog`, set validation ok; on fail set validation error.

`refreshModels`: same fetch without requiring re-enter key if key exists.

- [ ] **Step 3: Preload API**

Add `openai` namespace and extend `getConfig` types in `index.d.ts`.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/llm/effective-provider.ts src/main/ipc.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "feat: IPC for OpenAI validation and LLM provider config"
```

---

### Task 4: Settings UI

**Files:**
- Modify: `src/renderer/src/components/Settings.tsx`
- Modify: `src/renderer/src/App.tsx` (props + handlers)

**Interfaces:**
- Consumes: preload `config` + `openai` APIs from Task 3

- [ ] **Step 1: Extend Settings props**

Pass `llmProvider`, `openaiEnabled`, `openaiStatus`, handlers for provider/enabled/key/validate.

- [ ] **Step 2: UI sections**

LLM provider `<select>`. OpenAI: enable checkbox, key field, Validate button, status line, link to Models page. Update page subtitle.

- [ ] **Step 3: App.tsx state**

Load from `getConfig()`; on validate call `openai.validateAndFetchModels()` and refresh config.

- [ ] **Step 4: Manual check**

Run: `npm run dev` — Settings shows new controls; typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Settings.tsx src/renderer/src/App.tsx
git commit -m "feat: Settings UI for LLM provider and OpenAI key"
```

---

### Task 5: Models page — OpenAI catalog toggles

**Files:**
- Modify: `src/renderer/src/components/ModelsPage.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: OpenAI section**

When `openaiEnabled`, show catalog with search, per-row enable toggle calling `setOpenaiModelEnabled`, Refresh button, empty states for no validation / empty catalog.

- [ ] **Step 2: Wire selected OpenAI model indicator**

Read `selectedModelByProvider.openai` from config.

- [ ] **Step 3: Manual check**

Validate key in Settings → Models page lists models all off → toggle one on.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ModelsPage.tsx src/renderer/src/App.tsx
git commit -m "feat: enable OpenAI models on Models page"
```

---

### Task 6: LLM provider layer (Ollama adapter)

**Files:**
- Create: `src/main/llm/types.ts`
- Create: `src/main/llm/ollama-provider.ts`
- Create: `src/main/llm/index.ts`

**Interfaces:**
- Produces: `LlmProvider` interface matching what `agent.ts` needs from `chatStream`, `chatOnce`, `listModelsForChat`, `getModelInfo`, `modelIsImageGen`, `resolveContextLength`, `toProviderMessages` (or reuse `toOllamaMessages` name internally)

- [ ] **Step 1: Define interface from current `agent.ts` imports**

Read `agent.ts` and mirror option bags from `ollama.chatStream` / `chatOnce`.

- [ ] **Step 2: Ollama adapter delegates to `./ollama`**

- [ ] **Step 3: `getLlmProvider('ollama' | 'openai')`** — OpenAI stub throws `not implemented` until Task 7.

- [ ] **Step 4: typecheck + commit**

```bash
git add src/main/llm/
git commit -m "feat: LLM provider interface and Ollama adapter"
```

---

### Task 7: OpenAI provider (chat stream + tools)

**Files:**
- Create: `src/main/llm/openai-provider.ts`
- Modify: `src/main/openai-client.ts` (add streaming chat)

**Interfaces:**
- Produces: working `getLlmProvider('openai')` with `chatStream`, `chatOnce`, `listModelsForChat` (enabled + catalog), `getModelInfo`

- [ ] **Step 1: Message conversion**

Map `ChatMessage[]` / internal messages to OpenAI format; tool calls and tool results; images as base64 data URLs.

- [ ] **Step 2: SSE streaming parser**

Accumulate content; parse `tool_calls` deltas; return same shape as Ollama `chatStream` result.

- [ ] **Step 3: `chatOnce` non-stream for titles/compaction**

- [ ] **Step 4: Vision heuristic**

`getModelInfo`: vision true for `gpt-4o`, `gpt-4-turbo`, `gpt-4.1`, etc.; contextLength defaults (e.g. 128k) when unknown.

- [ ] **Step 5: typecheck + commit**

```bash
git add src/main/llm/openai-provider.ts src/main/openai-client.ts
git commit -m "feat: OpenAI Chat Completions provider with tools and streaming"
```

---

### Task 8: Refactor agent and related main callers

**Files:**
- Modify: `src/main/agent.ts`
- Modify: `src/main/session-title.ts`
- Modify: `src/main/context-compact.ts`
- Modify: `src/main/schedule-executor.ts` (if it imports ollama directly)

- [ ] **Step 1: At turn start in `agent.ts`**

```ts
const { effective, fallback, reason } = resolveEffectiveLlmProvider()
const provider = getLlmProvider(effective)
const model = getSelectedModelForProvider(effective)
if (fallback) emit warning event or set flag on chat event payload
```

Replace `chatStream`, `toOllamaMessages`, `getModelInfo`, etc. with provider calls. Keep `generateImageBase64` on Ollama-only path when `modelIsImageGen` and effective is ollama.

- [ ] **Step 2: session-title + context-compact**

Use effective provider + smallest chat model logic adapted for OpenAI list.

- [ ] **Step 3: Schedules / Telegram**

Ensure they use same agent entry (likely already through agent) — fix any direct `ollama` imports.

- [ ] **Step 4: typecheck**

Run: `npm run typecheck:node`

- [ ] **Step 5: Manual test**

Enable one OpenAI model; send message with MCP tool; confirm tool loop.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent.ts src/main/session-title.ts src/main/context-compact.ts
git commit -m "feat: route agent through LLM provider resolution"
```

---

### Task 9: Chat UI — dropdown and fallback banner

**Files:**
- Modify: `src/renderer/src/components/Chat.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Load models by configured `llmProvider`**

OpenAI: IPC list enabled models only (new handler or config-derived list). Ollama: existing list.

- [ ] **Step 2: Selection persists to correct provider slot**

- [ ] **Step 3: Banner when `llm:getEffectiveProvider` reports fallback**

- [ ] **Step 4: Adjust guards** (`ollamaOk` only when effective or configured Ollama needs connection — when provider OpenAI and validated, allow send even if Ollama offline unless fallback)

- [ ] **Step 5: Manual test + commit**

```bash
git add src/renderer/src/components/Chat.tsx src/renderer/src/App.tsx
git commit -m "feat: chat model dropdown and OpenAI fallback banner"
```

---

### Task 10: Cleanup legacy selectedModel IPC

**Files:**
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`

- [ ] **Step 1: Route `ollama:setSelectedModel` to `setSelectedModelForProvider('ollama', model)` for compatibility**

- [ ] **Step 2: Remove duplicate state in App if any**

- [ ] **Step 3: Full manual checklist from spec**

Run: `npm run typecheck` and spec manual tests 1–10.

- [ ] **Step 4: Commit**

```bash
git commit -am "chore: align selected model IPC with per-provider storage"
```

---

## Plan self-review

| Spec requirement | Task |
| --- | --- |
| Full agent OpenAI | 7, 8 |
| Enable + fallback C | 3, 8, 9 |
| Per-provider model B | 1, 9 |
| Fetch on validate, default disabled | 1, 2, 3, 5 |
| Models page toggles B | 5 |
| Dropdown enabled only | 5, 9 |
| Telegram/schedules | 8 |
| No OpenAI image gen v1 | 7, 8 |
| Security main-only | 2, 3, 7 |

No TBD placeholders remain. Project has no unit test runner; verification is `npm run typecheck` + manual checklist.

---

**Plan complete and saved to `docs/superpowers/plans/2026-09-23-openai-llm-provider.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — implement tasks in this session with checkpoints  

Which approach do you want?
