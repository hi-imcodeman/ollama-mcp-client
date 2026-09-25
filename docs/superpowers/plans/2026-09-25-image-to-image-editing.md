# Image-to-Image Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the built-in `generate_image` flow to edit or combine uploaded images through OpenAI while preserving text-only generation and rejecting Ollama image edits clearly.

**Architecture:** Keep one `generate_image` tool. The agent passes current-turn image payloads to tool execution, and the image tool chooses the existing generation path for text-only calls or a new multipart OpenAI Images Edits request when source images are present. Ollama remains text-to-image only.

**Tech Stack:** Electron main process, TypeScript, React renderer, OpenAI REST APIs, existing `fetch`/`AbortSignal` abstractions, and the repository’s TypeScript/build checks.

## Global Constraints

- Keep `prompt` required and `images` optional in the built-in tool schema.
- Do not infer image intent with regexes or heuristics; the LLM must invoke `generate_image`.
- Preserve the existing configured image-model routing.
- OpenAI image edits must support multiple uploaded images.
- Ollama image models must return a clear unsupported-operation tool error for image edits.
- Preserve existing generated-image rendering and model captions.
- Do not send production API requests in focused tests.
- Do not modify unrelated session, streaming, or UI behavior.

---

### Task 1: Add focused OpenAI image-edit API coverage

**Files:**
- Modify: `src/main/openai-image.ts`
- Test: `src/main/openai-image.test.ts` (create if the repository test setup supports it; otherwise add a focused test script under `scripts/`)

**Interfaces:**
- Consumes: selected OpenAI image model, prompt, raw base64 image payloads, API key, and optional `AbortSignal`.
- Produces: `editOpenAiImageBase64(model, prompt, images, signal?)`, returning the existing `{ b64, usage? }` result shape.

- [ ] **Step 1: Inspect the repository test runner and existing test conventions**

Run:

```bash
rg -n '"test"|vitest|jest|node:test|tsx' package.json scripts src
```

If no test runner exists, use a small `node:test`-compatible script only if it can execute TypeScript through the project’s existing tooling; otherwise document the API helper’s request contract and rely on typecheck/build plus a fetch mock harness that matches the repository’s available runtime.

- [ ] **Step 2: Write a failing test for one-image multipart editing**

The test must mock `fetch`, configure an API key through the existing config mechanism, call the new helper, and assert:

```ts
expect(fetch).toHaveBeenCalledWith(
  'https://api.openai.com/v1/images/edits',
  expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({
      Authorization: 'Bearer test-key'
    }),
    body: expect.any(FormData)
  })
)
```

Inspect the `FormData` entries and assert that `model`, `prompt`, `n=1`, and one `image` file are present. Return a mocked `{ data: [{ b64_json: 'edited-image' }] }` response and assert the helper returns `edited-image`.

- [ ] **Step 3: Run the focused test and verify it fails**

Run the repository’s discovered focused test command. Expected result: failure because `editOpenAiImageBase64` does not exist.

- [ ] **Step 4: Implement the minimal multipart helper**

Add a helper in `src/main/openai-image.ts` that:

1. Loads the configured OpenAI API key and throws the existing configuration error when absent.
2. Validates that the image array is non-empty.
3. Creates `FormData`.
4. Appends `model`, `prompt`, `n=1`, and one `image` `Blob` per base64 payload.
5. Posts to `${OPENAI_BASE}/images/edits` with the authorization header and optional signal.
6. Parses the first `b64_json` value using the existing normalization logic.
7. Uses `formatOpenAiError` for non-2xx responses and `parseOpenAiUsageFromJson` for usage.

Use the existing attachment payload convention: raw base64 without a data-URL prefix. Use `image/png` as the multipart content type unless a future attachment MIME field is added to the tool contract.

- [ ] **Step 5: Run the focused test and verify it passes**

Run the same focused test command. Expected result: PASS, including the multipart field and decoded output assertions.

- [ ] **Step 6: Add a failing test for multiple source images**

Assert that two source payloads create two separate `image` multipart entries, preserving order.

- [ ] **Step 7: Run the test, implement only the missing behavior, and rerun**

Expected result: the first run fails because only one image is appended; the corrected helper passes with two image parts.

- [ ] **Step 8: Commit the isolated API helper change**

```bash
git add src/main/openai-image.ts src/main/openai-image.test.ts scripts
git commit -m "feat: add OpenAI image editing request"
```

---

### Task 2: Extend the built-in image tool contract and routing

**Files:**
- Modify: `src/main/image-gen-tool.ts`
- Test: `src/main/image-gen-tool.test.ts` or the repository’s focused test location

**Interfaces:**
- Consumes: existing `runGenerateImageTool(provider, args, signal?)`, plus current-turn images supplied by the agent.
- Produces: optional image-source handling and clear Ollama rejection while retaining `GenerateImageToolResult`.

- [ ] **Step 1: Write a failing schema test**

Assert that `generateImageToolDefinition()` keeps `prompt` required and exposes an optional `images` array with string items.

- [ ] **Step 2: Run the test and verify it fails**

Expected result: the schema has no `images` property.

- [ ] **Step 3: Write a failing OpenAI routing test**

Pass `{ prompt: 'remove the background', images: ['base64-image'] }` to tool execution with an OpenAI backend selected. Mock model discovery and the OpenAI edit helper. Assert that the edit helper receives the selected model, prompt, and image list.

- [ ] **Step 4: Implement argument validation and OpenAI edit routing**

Update the tool definition description and parameters. In `runGenerateImageTool`:

1. Read optional `args.images`.
2. Require an array of non-empty strings when provided.
3. Deduplicate exact payloads while preserving order.
4. Resolve the configured backend as today.
5. If images exist and the backend is OpenAI, call `editOpenAiImageBase64`.
6. If images exist and the backend is Ollama, return:

```text
Image editing requires an OpenAI image model. Select an OpenAI image model and try again.
```

7. Keep text-only requests on the existing provider-specific generation paths.

- [ ] **Step 5: Run the routing tests and verify they pass**

Run the focused tool tests. Expected result: schema and OpenAI edit routing pass.

- [ ] **Step 6: Add and pass an Ollama rejection test**

Mock an Ollama image backend, provide a non-empty image list, and assert `ok: false` with the exact unsupported-operation message. Assert that the Ollama text-generation helper is not called.

- [ ] **Step 7: Commit the tool contract and routing change**

```bash
git add src/main/image-gen-tool.ts src/main/image-gen-tool.test.ts
git commit -m "feat: route image tool edits to OpenAI"
```

---

### Task 3: Pass current-turn attachments into image-tool execution

**Files:**
- Modify: `src/main/agent.ts`
- Modify: `src/shared/types.ts` only if the existing internal call type requires a named field
- Test: `src/main/agent.test.ts` or the repository’s focused test location

**Interfaces:**
- Consumes: `ChatSendPayload.messages`, where the current user message may contain `images`.
- Produces: `runGenerateImageTool` calls containing the current turn’s image payloads when the LLM emits `generate_image`.

- [ ] **Step 1: Write a failing agent/tool integration test**

Construct a turn with a user message containing two images. Make the mocked LLM emit a `generate_image` tool call with a prompt but no image arguments. Assert that the image tool receives both current-turn images and the prompt.

- [ ] **Step 2: Run the test and verify it fails**

Expected result: the tool receives only the model arguments or no images.

- [ ] **Step 3: Implement current-turn image propagation**

At the tool-iteration boundary in `src/main/agent.ts`, derive the source image list from the current user turn’s `images`. When handling `GENERATE_IMAGE_NAME`, construct tool arguments with the current-turn images only if the LLM did not provide an image list, or merge and deduplicate the two lists if it did. Do not add images from earlier conversation turns.

- [ ] **Step 4: Preserve existing tool result and assistant image events**

Keep the existing `assistant_images` event, selected model metadata, MIME type, and tool result text unchanged. Only the input arguments change.

- [ ] **Step 5: Run the focused integration test and verify it passes**

Expected result: the image tool gets all current-turn attachments, including multiple images, and generated output still produces the existing assistant image event.

- [ ] **Step 6: Commit the agent propagation change**

```bash
git add src/main/agent.ts src/shared/types.ts src/main/agent.test.ts
git commit -m "feat: pass attachments to image tool edits"
```

---

### Task 4: Verify end-to-end behavior and compatibility

**Files:**
- Modify: only files required by failing verification

- [ ] **Step 1: Run all focused tests**

Run the project’s discovered test command. Expected result: all image API, tool routing, and agent propagation tests pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected result: node and web TypeScript checks pass.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected result: Electron main, preload, and renderer bundles build successfully.

- [ ] **Step 4: Check formatting and diff whitespace**

```bash
git diff --check
```

Expected result: no whitespace errors.

- [ ] **Step 5: Manually verify the four required paths**

With the dev app running:

1. Text-only prompt with OpenAI image model still generates an image.
2. One attached image plus “remove the background” calls OpenAI edits.
3. Multiple attached images plus a composition prompt sends all images.
4. Attached image plus an Ollama image model returns the clear OpenAI-required error and does not generate a text-only substitute.

- [ ] **Step 6: Commit the final verification adjustments, if any**

```bash
git add src/main src/shared
git commit -m "test: verify image editing flows"
```
