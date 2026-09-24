# OpenAI LLM provider

Date: 2026-09-23

## Problem

The app is Ollama-only. Users who want cloud models must run Ollama locally. There is no way to choose OpenAI, store an API key, or route the MCP agent through OpenAI chat completions.

## Goal

Add optional OpenAI as a second LLM provider with the **same full agent path** as Ollama: MCP tools, streaming, vision attachments where the model supports them, session title generation, context compaction, Telegram turns, and scheduled runs.

## Decisions (from brainstorming)

| Topic | Choice |
| --- | --- |
| Scope | Full agent on OpenAI (not chat-only) |
| Enable vs provider | **Enable** unlocks OpenAI (key + validation). **Provider** dropdown is independent. If provider is OpenAI but OpenAI is unavailable, **runtime fallback to Ollama** with a visible warning (do not mutate stored provider). |
| Selected model | **Per provider:** remember last model separately for Ollama and OpenAI |
| OpenAI model list | After key **validation**, `GET /v1/models`; store full catalog; **new models default disabled** |
| Chat dropdown | OpenAI: only **enabled** models; Ollama: unchanged (installed local models) |
| Enable/disable UI | **Models page** — OpenAI section alongside existing Ollama UI |
| Image generation | **Ollama only in v1** (OpenAI Images API out of scope); OpenAI chat still supports vision **input** |
| Architecture | **Provider interface** — `OllamaProvider` wraps existing code; new `OpenAIProvider` |

## Config

Extend `AppConfig` and `electron-store`:

```ts
export type LlmProvider = 'ollama' | 'openai'

export interface OpenAiModelEntry {
  id: string
  ownedBy?: string
  created?: number
}

export interface AppConfig {
  // existing fields…
  llmProvider: LlmProvider // default 'ollama'
  openaiEnabled: boolean // default false
  openaiApiKey: string | null // default null
  openaiValidationOk: boolean // last validate attempt succeeded
  openaiValidationError: string | null
  openaiModelsCatalog: OpenAiModelEntry[]
  openaiModelEnabled: Record<string, boolean> // missing or false = disabled
  selectedModelByProvider: {
    ollama: string | null
    openai: string | null
  }
}
```

**Migration on read:** If `selectedModelByProvider` is absent, set `ollama` from legacy `selectedModel`, `openai: null`. Keep reading legacy `selectedModel` only for one-time migration, then write the new shape.

**Deprecation:** Stop writing standalone `selectedModel`; IPC may accept it briefly for compatibility but UI uses `selectedModelByProvider`.

## Effective provider resolution

Main-process helper `resolveEffectiveLlmProvider()`:

1. If `llmProvider !== 'openai'` → `'ollama'`.
2. If `llmProvider === 'openai'` but any of: `!openaiEnabled`, no `openaiApiKey`, or `!openaiValidationOk` → `'ollama'` and return `{ fallback: true, reason: string }`.
3. Else → `'openai'`.

Expose `getSelectedModelForProvider(provider)` reading `selectedModelByProvider[provider]`.

Chat/agent uses **effective** provider + that provider’s selected model id.

## OpenAI API (main process)

- Base URL: `https://api.openai.com/v1` (fixed in v1).
- **Validate key:** `GET /v1/models` with `Authorization: Bearer <key>`. On 200, set `openaiValidationOk: true`, clear error, refresh catalog.
- **Catalog merge:** Replace catalog from response; for each new `id`, set `openaiModelEnabled[id]` to `false` if not already present; remove enabled flags for ids no longer in catalog.
- **Chat:** `POST /v1/chat/completions` with `stream: true`, `tools` when MCP tools present, map SSE to existing agent expectations (content deltas, tool calls, usage when present).
- **Messages:** Map internal history to OpenAI roles; tool results as tool messages; images as `image_url` (base64 data URLs) for vision-capable models.
- **Abort:** Wire `AbortSignal` from existing turn abort controller.

Filter catalog for display on Models page: exclude obvious non-chat families where practical (e.g. `text-embedding-*`, `whisper-*`, `tts-*`, `dall-e-*`) via id prefix/heuristics; still store raw list or filtered list consistently (document: store filtered chat-relevant ids only to reduce noise).

## Provider interface

```ts
// src/main/llm/types.ts (illustrative)
export interface LlmChatStreamResult {
  content: string
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
  promptEvalCount?: number
  evalCount?: number
  evalDurationNs?: number
}

export interface LlmProvider {
  id: LlmProvider
  chatStream(options: { /* mirror ollama chatStream inputs */ }): Promise<LlmChatStreamResult>
  chatOnce(options: { /* mirror ollama chatOnce */ }): Promise<string>
  listModelsForChat(): Promise<Array<{ name: string; /* tags for UI */ }>>
  getModelInfo(model: string): Promise<{ contextLength?: number; vision?: boolean; imageGen?: boolean }>
}
```

`getLlmProvider(id)` returns singleton adapters. `agent.ts`, `session-title.ts`, `context-compact.ts`, and schedule execution import `resolveEffectiveLlmProvider()` + provider methods instead of calling `ollama` directly (except `ollama-image` / pull / library IPC).

## Settings UI

- Subtitle: mention LLM provider, not Ollama only.
- **LLM provider** select: Ollama | OpenAI.
- **OpenAI section:**
  - Checkbox: Enable OpenAI (disabled state greys out key/validate).
  - API key (password + show/hide), Save/Validate button.
  - Status: validated / invalid / not configured.
  - Link text: “Manage OpenAI models on the Models page.”
- **Ollama section:** unchanged.

## Models page

- Tab or split section: **Local (Ollama)** — existing UI.
- **OpenAI** section visible when `openaiEnabled`:
  - Requires validated catalog; else prompt to validate in Settings.
  - Searchable list of catalog models with **Enabled for chat** toggle per row.
  - **Refresh models** → same fetch/merge as validation.
  - Show which model is selected for OpenAI (if any).

## Chat UI

- Model dropdown source depends on **configured** `llmProvider` (not effective fallback target for listing — when user chose OpenAI, show enabled OpenAI models even if fallback will happen; show banner when fallback active).
- When `llmProvider === 'openai'`: list = enabled catalog ids only.
- When `llmProvider === 'ollama'`: existing `listModels`.
- Persist selection to correct slot in `selectedModelByProvider`.
- Banner when effective provider is Ollama but configured provider is OpenAI: show `reason` once per session or once per turn (prefer per turn start).

## IPC / preload

New handlers (names illustrative):

- `config:setLlmProvider`
- `config:setOpenaiEnabled`
- `config:setOpenaiApiKey`
- `openai:validateAndFetchModels`
- `openai:refreshModels`
- `config:setOpenaiModelEnabled` (id, enabled)
- `config:setSelectedModelForProvider` (provider, model)
- `llm:getEffectiveProvider` → `{ configured, effective, fallback?, reason? }`

Extend `config:get` with all new fields.

## Agent & related main modules

- **agent.ts:** Use effective provider for all model calls; image-gen branch only when Ollama image-gen model on Ollama effective path.
- **session-title.ts:** `listModels` + `chatOnce` via provider.
- **context-compact.ts:** `chatOnce` via provider.
- **schedule-executor.ts:** Same as agent turn resolution.

## Security

- API key stored in electron-store; never log key; renderer receives only masked hint (e.g. last 4 chars) optional.
- All OpenAI HTTP from main process only.

## Edge cases

- Validate fails: keep previous catalog if any; set `openaiValidationOk: false`.
- User disables OpenAI: do not clear key/catalog; toggles inactive; effective provider becomes Ollama when configured provider was OpenAI.
- User enables model then refresh removes id: clear from enabled map; if it was selected OpenAI model, set `selectedModelByProvider.openai` to null.
- No enabled OpenAI models: dropdown empty with helper to enable models on Models page.
- Tool calling on models without tool support: surface API error in chat (no silent fallback).

## Non-goals (v1)

- Custom OpenAI base URL / Azure
- OpenAI image generation (DALL·E)
- Per-session provider override
- Auto-enable any OpenAI model

## Manual test checklist

1. Fresh install: provider Ollama, behavior unchanged.
2. Enable OpenAI, invalid key → validation error, no catalog.
3. Valid key → catalog populated, all toggles off, none in chat dropdown.
4. Enable one model → appears in dropdown only when provider OpenAI.
5. Chat with tools on enabled GPT model → tools execute, stream completes.
6. Provider OpenAI, disable OpenAI or remove key → send message → Ollama runs + warning banner.
7. Switch provider Ollama ↔ OpenAI → each restores its last selected model.
8. Telegram message uses same effective provider as desktop config.
9. Vision attachment on `gpt-4o` (or similar) with OpenAI provider.
10. `npm run typecheck` passes.
