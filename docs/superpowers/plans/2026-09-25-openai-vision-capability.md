# OpenAI vision capability detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Detect vision-capable OpenAI chat models consistently so supported models can receive image attachments.

**Architecture:** Add a pure shared classifier in `src/shared/openai-models.ts`. OpenAI provider metadata and `detectVisionSupport` will use it, while the existing OpenAI `image_url` conversion remains unchanged. Renderer warnings will continue to warn only on definite `no`, with unknown models allowed to attempt image input.

**Tech Stack:** TypeScript, Electron main process, React renderer, OpenAI Chat Completions image-content format.

## Global Constraints

- Use a static allowlist; do not add per-message API probes.
- Return `yes` for recognized multimodal families and `unknown` for unrecognized OpenAI IDs.
- Include `gpt-4o`, `gpt-4.1`, `gpt-4.5`, `gpt-5`, `o1`, `o3`, `o4-mini`, and any `gpt-<major>` where `major > 5`.
- Exclude image-generation-only models from chat selection and vision-chat classification.
- Preserve existing `image_url` data-URL conversion.
- Warn users only when support is definitively `no`; unknown models may attempt image input.
- Do not add a new test runner.

---

## File map

- Modify `src/shared/openai-models.ts`: add the pure OpenAI vision classifier.
- Modify `src/main/llm/openai-provider.ts`: use the shared classifier for tags and `detectVisionSupport`.
- Modify `src/renderer/src/components/Chat.tsx` only if the existing capability tags do not propagate correctly.

### Task 1: Add the shared OpenAI vision classifier

**Files:**
- Modify: `src/shared/openai-models.ts`

**Interfaces:**
- Produce `isOpenAiVisionModel(model: string): boolean`.
- Preserve `isOpenAiImageGenModel(model: string): boolean`.

- [ ] **Step 1: Define expected classifications**

The pure function must return:

```ts
isOpenAiVisionModel('gpt-4o') === true
isOpenAiVisionModel('gpt-4.1-mini') === true
isOpenAiVisionModel('gpt-4.5') === true
isOpenAiVisionModel('gpt-5.6-sol') === true
isOpenAiVisionModel('gpt-6-preview') === true
isOpenAiVisionModel('o3') === true
isOpenAiVisionModel('o4-mini') === true
isOpenAiVisionModel('text-embedding-3-large') === false
isOpenAiVisionModel('gpt-image-1') === false
isOpenAiVisionModel('some-future-model') === false
```

- [ ] **Step 2: Run the baseline typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Implement the classifier**

Implement these rules in order:

1. Return `false` when `isOpenAiImageGenModel(model)` is true.
2. Return `true` when the lowercase ID contains `vision`.
3. Return `true` for `gpt-4o`, `gpt-4.1`, `gpt-4.5`, and `gpt-5` families.
4. Parse `/^gpt-(\d+)/`; return `true` when the numeric major is greater than `5`.
5. Return `true` for `o1`, `o3`, and `o4-mini` families.
6. Return `false` otherwise.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/openai-models.ts
git commit -m "feat: classify OpenAI vision models"
```

### Task 2: Integrate vision detection into the OpenAI provider

**Files:**
- Modify: `src/main/llm/openai-provider.ts`

**Interfaces:**
- Consume `isOpenAiVisionModel(model: string): boolean`.
- Preserve `LlmProvider.detectVisionSupport(): 'yes' | 'no' | 'unknown'`.

- [ ] **Step 1: Update OpenAI capability tags**

Replace the current `gpt-4o`/`vision` condition in `openAiModelTags` with:

```ts
if (isOpenAiVisionModel(id)) tags.push('vision')
```

Keep `openai`, `image`, and `thinking` tags unchanged.

- [ ] **Step 2: Update `detectVisionSupport`**

Use the existing Ollama detector only as a fallback for compatibility, then use the shared OpenAI classifier:

```ts
detectVisionSupport(model, info) {
  const support = ollamaDetectVision(model, info ? { capabilities: info.capabilities } : null)
  if (support !== 'unknown') return support
  return isOpenAiVisionModel(model) ? 'yes' : 'unknown'
}
```

Do not return `no` for unrecognized OpenAI model IDs.

- [ ] **Step 3: Run typecheck and lint**

Run: `npm run typecheck`; then inspect diagnostics for `src/main/llm/openai-provider.ts`.

Expected: PASS with no new diagnostics.

- [ ] **Step 4: Commit**

```bash
git add src/main/llm/openai-provider.ts
git commit -m "feat: use shared OpenAI vision detection"
```

### Task 3: Verify image attachment behavior

**Files:**
- No production files unless verification identifies a defect.

- [ ] **Step 1: Verify OpenAI payload conversion**

Confirm `ollamaMessagesToOpenAi()` continues to convert each raw base64 attachment to:

```ts
{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
```

Do not change the payload format in this task.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 3: Check UI behavior**

For each model classification:

1. `gpt-4o`, `gpt-4.1`, `o3`, `o4-mini`, and `gpt-6` show the `vision` capability.
2. An attached image does not show the unsupported-image warning for those models.
3. Unknown models are not blocked by the warning.
4. Clearly non-vision models may still show the warning only when the existing metadata proves `no`.

- [ ] **Step 4: Check diagnostics and working tree**

Inspect linter diagnostics for changed files and run:

```bash
git status --short
```

Expected: no linter errors and only intended changes.
