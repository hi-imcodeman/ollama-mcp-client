# Provider-aware image tool routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the built-in `generate_image` tool available to OpenAI chat models and execute it through OpenAI while preserving Ollama behavior.

**Architecture:** Keep the existing shared `defaultImageModel` setting and introduce provider-aware image-model discovery and resolution in `image-gen-tool.ts`. The agent passes the effective provider into availability and execution, while the existing direct image-model path remains unchanged. OpenAI image models come from the enabled OpenAI catalog; Ollama models continue to come from the installed Ollama model list.

**Tech Stack:** TypeScript, Electron main process, React renderer, OpenAI Images/Responses API, existing Ollama HTTP client, `electron-store`.

## Global Constraints

- Keep one shared `defaultImageModel` setting.
- Keep the tool name exactly `generate_image` with required argument `{ prompt: string }`.
- Do not inject the tool when the selected model is itself an image-generation model.
- Do not expose the tool when the active provider has no available image model.
- OpenAI availability uses only enabled models from the OpenAI catalog.
- Ollama availability and generation behavior must remain unchanged.
- Do not put base64 image data in model-facing tool results.
- Preserve `tool_start`, `assistant_images`, and `tool_result` events.
- Do not add a new test runner; use pure exported helpers plus `npm run typecheck` and focused runtime checks.

---

## File map

- Modify `src/main/image-gen-tool.ts`: provider-aware availability, model resolution, and generation dispatch.
- Modify `src/main/agent.ts`: pass the effective provider into image-tool gating and execution.
- Modify `src/main/llm/types.ts`: no change expected unless a provider type import is needed by shared signatures.
- Modify `src/main/openai-image.ts`: no behavior change expected; reuse `generateOpenAiImageBase64`.
- Modify `src/main/config-store.ts`: no change expected; reuse `defaultImageModel`.
- Modify `src/main/llm/effective-provider.ts`: no behavior change expected; effective provider remains authoritative.
- Modify `src/renderer/src/components/Settings.tsx`: display the merged Ollama/OpenAI image-model choices.
- Modify `src/renderer/src/App.tsx`: derive and pass the merged image-model choices.
- Add `src/shared/openai-models.ts`: share OpenAI image-model classification between main and renderer.

### Task 1: Add provider-aware pure model helpers

**Files:**
- Modify: `src/main/image-gen-tool.ts`
- Add: `src/shared/openai-models.ts`

**Interfaces:**
- Consume `LlmProvider` from `src/shared/types.ts`.
- Produce `isOpenAiImageGenModel(model: string): boolean` from `src/shared/openai-models.ts`.
- Produce:
  - `resolveDefaultImageModel(configured: string | null, imageModelNames: string[]): string | null`
  - `resolveImageModelForProvider(provider: LlmProvider, configured: string | null, availableModels: string[]): string | null`
  - `isImageModelAvailable(provider: LlmProvider, model: string, availableModels: string[]): boolean`

- [ ] **Step 1: Extract the OpenAI image-model predicate**

Move the pure `isOpenAiImageGenModel` implementation from `src/main/openai-image.ts` to `src/shared/openai-models.ts`, export it there, and import it from both `openai-image.ts` and the image-tool module. Keep the existing matching rules unchanged (`gpt-image`, `dall-e`, and `gpt-<number>...image`).

- [ ] **Step 2: Define provider-specific expected behavior**

The existing Ollama helper remains unchanged. Add a provider-aware helper whose behavior is:

```ts
resolveImageModelForProvider('ollama', configured, ['flux']) // existing configured-or-first behavior
resolveImageModelForProvider('openai', 'gpt-image-1', ['gpt-image-1']) // 'gpt-image-1'
resolveImageModelForProvider('openai', 'dall-e-3', ['gpt-image-1']) // 'gpt-image-1'
resolveImageModelForProvider('openai', null, []) // null
```

The caller must supply an already-filtered list of models available to that provider.

- [ ] **Step 3: Run the existing typecheck before changes**

Run: `npm run typecheck`

Expected: PASS, establishing the current baseline.

- [ ] **Step 4: Implement the minimal pure helpers**

Import `LlmProvider` and implement the provider-aware resolver by reusing `resolveDefaultImageModel`. Keep provider branching at the boundary so the existing Ollama fallback semantics do not change.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/image-gen-tool.ts src/shared/openai-models.ts src/main/openai-image.ts
git commit -m "feat: add provider-aware image model resolution"
```

### Task 2: Discover OpenAI image models and gate the tool

**Files:**
- Modify: `src/main/image-gen-tool.ts`

**Interfaces:**
- Consume `getOpenaiModelEnabledMap`, `getOpenaiModelsCatalog`, and `isOpenAiImageGenModel`.
- Produce:
  - `listAvailableImageModelNames(provider: LlmProvider): Promise<string[]>`
  - `shouldOfferGenerateImageTool(provider: LlmProvider, selectedModel: string): Promise<boolean>`

- [ ] **Step 1: Implement OpenAI catalog filtering**

For `provider === 'openai'`, read the stored catalog and enabled map, then return only model IDs satisfying both:

```ts
enabled[id] === true && isOpenAiImageGenModel(id)
```

Do not call Ollama APIs in this branch.

- [ ] **Step 2: Preserve and isolate Ollama discovery**

For `provider === 'ollama'`, retain the current status gate and `listModels()` logic:

```ts
const status = await getOllamaStatus()
if (!status.ok || status.imageGenSupported === false) return []
```

Return installed models identified by the existing `modelIsImageGen` helper. Catch model-list errors and return an empty list.

- [ ] **Step 3: Make tool gating provider-aware**

The new signature must reject tool injection when the selected model is image-generation capable, and otherwise return whether the provider’s available image list is non-empty:

```ts
const available = await listAvailableImageModelNames(provider)
return !available.includes(selectedModel) && available.length > 0
```

For Ollama, retain capability-based selected-model detection so an image model selected in the chat dropdown still uses direct generation.

- [ ] **Step 4: Verify the gate**

Run: `npm run typecheck`

Expected: PASS. Also run a focused runtime check through the development process or a temporary Node evaluation of the pure resolver cases; verify OpenAI gating does not require Ollama to be online.

- [ ] **Step 5: Commit**

```bash
git add src/main/image-gen-tool.ts
git commit -m "feat: gate image tool by active provider"
```

### Task 3: Route image-tool execution through the active provider

**Files:**
- Modify: `src/main/image-gen-tool.ts`
- Modify: `src/main/agent.ts`

**Interfaces:**
- `runGenerateImageTool(provider: LlmProvider, args: Record<string, unknown>, signal?: AbortSignal): Promise<GenerateImageToolResult>`
- `shouldOfferGenerateImageTool(provider: LlmProvider, selectedModel: string): Promise<boolean>`

- [ ] **Step 1: Write the failing integration contract**

Before changing callers, update the image-tool call contract so TypeScript reports every old call site. The expected failures should identify the direct-image heuristic path, inferred-tool path, and normal tool-dispatch path in `agent.ts`.

- [ ] **Step 2: Implement provider-specific generation**

In `runGenerateImageTool`:

1. Validate the trimmed prompt.
2. Call `listAvailableImageModelNames(provider)`.
3. Resolve the shared configured model against that list.
4. Return the existing no-model error if resolution returns `null`.
5. Call `generateOpenAiImageBase64(model, prompt, signal)` for OpenAI.
6. Call `generateImageBase64(model, prompt, signal)` for Ollama.
7. Return `{ ok: true, model, imageBase64, message }`.
8. Convert provider exceptions to `{ ok: false, message }`.

Do not include `imageBase64` in `message`.

- [ ] **Step 3: Pass `effective` into agent gating**

Change the agent call after the direct image-model early return from:

```ts
const offerImageTool = await shouldOfferGenerateImageTool(turnModel)
```

to:

```ts
const offerImageTool = await shouldOfferGenerateImageTool(effective, turnModel)
```

- [ ] **Step 4: Pass `effective` into every tool execution**

Update all three `runGenerateImageTool` calls in `agent.ts`:

```ts
await runGenerateImageTool(effective, { prompt: lastUserPrompt }, abort.signal)
await runGenerateImageTool(effective, { prompt: lastUserPrompt }, abort.signal)
await runGenerateImageTool(effective, tc.arguments, abort.signal)
```

Keep existing event sequencing and abort checks unchanged.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS with no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/image-gen-tool.ts src/main/agent.ts
git commit -m "feat: execute image tool with active provider"
```

### Task 4: Make the shared selection usable for OpenAI image models

**Files:**
- Modify: `src/renderer/src/components/Settings.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/shared/types.ts` only if a new view-model type is needed
- Consume: `isOpenAiImageGenModel` from `src/shared/openai-models.ts`

**Interfaces:**
- Preserve `defaultImageModel: string | null`.
- Preserve `onSetDefaultImageModel(model: string | null): void`.

- [ ] **Step 1: Pass enabled OpenAI image models into Settings**

In `App.tsx`, derive OpenAI image models from `openaiCatalog` using `isOpenAiImageGenModel` and `openaiModelEnabled`. Merge them with the existing Ollama image models by unique `name`/ID and pass the resulting list to `Settings`.

- [ ] **Step 2: Render provider-neutral choices**

Keep `Auto (first available)` and render each unique model ID once. Do not show an Ollama-only “image generation unavailable” message when OpenAI image models are enabled and OpenAI is the effective provider.

- [ ] **Step 3: Verify persistence and typecheck**

Run: `npm run typecheck`

Expected: PASS. In the app, set a model, reload config, and confirm the same shared value is restored.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Settings.tsx src/renderer/src/App.tsx src/shared/types.ts
git commit -m "feat: expose shared OpenAI image model selection"
```

### Task 5: Verify the regression and provider routing

**Files:**
- No production files unless verification reveals a defect.

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`

Expected:

```text
typecheck:node succeeds
typecheck:web succeeds
```

- [ ] **Step 2: Verify OpenAI chat-tool injection**

With OpenAI enabled, validated, and an enabled image model in the catalog:

1. Select an OpenAI chat model.
2. Ask for an image.
3. Confirm the main-process log contains `provider=openai ... tools=1`.
4. Confirm a `generate_image` tool card appears.
5. Confirm the OpenAI image endpoint is called and an image appears.

- [ ] **Step 3: Verify shared fallback**

Set `defaultImageModel` to an Ollama image model while using OpenAI. Confirm generation falls back to the first enabled OpenAI image model without mutating the saved setting.

- [ ] **Step 4: Verify Ollama regressions**

Confirm:

1. Ollama chat + installed image model injects the tool.
2. Ollama image model selected directly uses the direct path with `tools=0`.
3. OpenAI image models do not require Ollama to be online.
4. No available image model produces `tools=0`.
5. Abort does not emit a completed image.

- [ ] **Step 5: Run diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended changes.

