# Provider-aware image tool routing

Date: 2026-09-24

## Problem

When OpenAI is the active LLM provider and a chat model is selected, the agent
currently logs `tools=0`. The built-in `generate_image` tool is gated only by
Ollama availability, so OpenAI chat models cannot request image generation even
when an OpenAI image model is enabled.

## Goal

Allow chat models from either configured provider to call the built-in
`generate_image` tool. The tool must execute through the matching image API and
preserve the existing UI events and Ollama behavior.

## Decisions

| Topic | Decision |
| --- | --- |
| Image-model setting | Keep one shared `defaultImageModel` setting |
| OpenAI model resolution | Use the configured value when it matches an enabled OpenAI image model; otherwise use the first enabled OpenAI image model |
| Ollama model resolution | Keep the existing configured-or-first-installed resolution |
| Direct image-model selection | Preserve the existing direct image-generation path |
| Tool name and arguments | Keep `generate_image` with `{ prompt: string }` |
| UI events | Continue emitting `tool_start`, `assistant_images`, and `tool_result` |
| Scope | Shared agent path, covering desktop, Telegram, and schedules |

## Architecture

At the start of a non-image-model turn, determine image-tool availability from
the effective provider:

1. For Ollama, require a reachable/supported Ollama instance and at least one
   installed image-capable model.
2. For OpenAI, require a configured validated provider and at least one enabled
   image-capable model in the OpenAI catalog.
3. If available, append the existing `generate_image` definition to skills and
   MCP tools.
4. If the selected model is itself an image-generation model, keep the current
   direct path and do not inject the tool.

The tool handler receives the effective provider and resolves the shared
configured model against that provider's available image models. It calls
`generateOpenAiImageBase64` for OpenAI or `generateImageBase64` for Ollama.
Generated base64 remains an `assistant_images` event payload and is never
returned in the model-facing tool result.

## Model classification

OpenAI image models are identified using the existing
`isOpenAiImageGenModel` helper. The OpenAI catalog is filtered to models enabled
in Settings before availability and resolution checks. Ollama classification
continues to use its existing capability/name detection.

The shared setting may contain a model from the other provider. Such a value is
treated as stale for the active provider and falls back to that provider's
first available image model. The setting itself is not overwritten during
fallback.

## Error handling

- No available image model: do not expose the tool.
- Missing or invalid prompt: return the existing clear tool error.
- Provider image API failure: return a failed `tool_result` with the API error.
- Abort during generation: stop without emitting a completed image.
- OpenAI validation/API-key failure: the existing effective-provider fallback
  remains authoritative; if Ollama is effective, use Ollama rules.

## Settings

Keep the existing single default-image-model control. Its current Ollama model
list remains the visible source of choices. OpenAI models can still be selected
through the shared value programmatically or via future UI enhancement; OpenAI
availability must not depend on an Ollama image model being installed.

## Verification

- Add focused tests or pure helper checks for provider-specific image-model
  resolution and availability gates where the project test setup permits.
- Run `npm run typecheck`.
- In development, select an OpenAI chat model with an enabled OpenAI image model
  and confirm the agent log reports `provider=openai ... tools=1`.
- Confirm a request emits the image tool events and calls the OpenAI image API.
- Confirm Ollama chat and direct image-model behavior remain unchanged.
