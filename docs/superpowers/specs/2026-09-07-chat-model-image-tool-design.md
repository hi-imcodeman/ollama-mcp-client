# Chat model image generation via built-in tool

Date: 2026-09-07

## Problem

Image models and chat models share the same dropdown. Image generation only runs when an **image** model is selected (direct `/api/generate` path). If the user keeps a text/chat model selected and asks it to generate an image, the model cannot produce one.

## Goal

When a **chat** model is selected, expose a built-in `generate_image` tool so the model can request image generation. The app runs a configured (or auto-picked) image model under the hood and surfaces the result like today’s image turns.

Applies everywhere the agent runs: desktop chat, Telegram, and schedules.

## Decisions

| Topic | Choice |
| --- | --- |
| Trigger | Built-in tool `generate_image` (same pattern as `load_skill`) |
| Default image model | Settings value, else first installed image-capable model |
| No image models | Do not expose the tool; no generation |
| Image model selected in dropdown | Keep current direct prompt→image path; do not inject the tool |
| Scope | All agent entry points |

## Architecture

1. At turn start, if the selected model is **not** image-gen, Ollama supports image generation, and at least one image model is installed → include `generate_image` in the tool list (alongside skills + MCP tools).
2. Otherwise omit the tool.
3. If the selected model **is** image-gen → existing direct path only (unchanged).

### Image model resolution

1. `defaultImageModel` from config, if it is still an installed image-capable model.
2. Else the first installed image-capable model (treat as Auto).
3. Else no model → tool must not have been offered; if somehow called, fail the tool.

Stale saved defaults (model uninstalled) fall through to step 2.

## Config

```ts
// AppConfig
defaultImageModel: string | null // null = Auto (first installed image model)
```

- Persist via `config-store.ts` / `electron-store`
- IPC: include in `config:get`; add setter (e.g. `config:setDefaultImageModel`)
- Preload: typed `window.api` bridge

## Built-in tool

| Field | Value |
| --- | --- |
| Name | `generate_image` |
| Arguments | `{ prompt: string }` (required) |
| Description | Instruct the chat model to call this when the user asks for an image; `prompt` is the full image-generation prompt |

### Handler

1. Validate non-empty `prompt`; else `ok: false` with a clear message.
2. Resolve image model (see above).
3. Emit status `Generating image…`.
4. Call existing `generateImageBase64(model, prompt, signal)`.
5. On success: emit `assistant_images` (same event as direct image path) and return a short text tool result to the model (e.g. which model produced the image).
6. On failure or abort: `ok: false` with the error message; turn continues so the chat model can respond.

Do not put raw base64 into the tool result text for the model (too large); images reach the UI via `assistant_images` only.

## Settings UI

Under **Chat** in Settings:

- **Default image model** — select: **Auto (first available)** + installed image-capable models only.
- If none installed: disable the control and note that image generation is unavailable until an image model is installed.
- Helper text: used when a chat model calls `generate_image`.

Chat model dropdown behavior is unchanged (still lists text and image models).

## Edge cases

| Case | Behavior |
| --- | --- |
| Ollama build without image gen | Tool not offered |
| No image models installed | Tool not offered |
| Empty prompt | Tool fails; model can retry |
| Generation error / abort | Tool fails; no hung turn |
| Stale `defaultImageModel` | Fall back to first installed image model |
| Selected model is image-gen | Direct path; tool not injected |
| Multiple tool calls in one turn | Each `generate_image` call generates and emits images independently |

## Non-goals

- Extra generation params (size, seed, steps, style presets)
- Removing image models from the chat dropdown
- Auto-pulling image models from the library
- Keyword/heuristic routing without a tool call
- Pseudo-MCP “builtin” server wrapper

## Manual test

1. Chat model + ≥1 image model, default Auto → ask to draw something → tool runs, image appears, optional caption.
2. Pin a specific default image model in Settings → request uses that model (visible in tool result / status).
3. Remove all image models → tool absent; reply is text-only.
4. Select an image model in the dropdown → direct prompt→image (no tool).
5. Abort mid-generation → tool fails cleanly.
6. Telegram or schedule with a chat model → same tool + image delivery via existing mirror path.

## Light automated checks (optional)

- Resolve helper: `null` → first image model; stale name → fallback; empty list → `null`.
- Gating: image-selected model / no image models / unsupported Ollama → tool not offered.
