# Image Generation and Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add separate LLM-selected `generate_image` and `edit_image` tools, carrying current uploads or the latest generated image into follow-up edits.

**Architecture:** Keep image-source selection in the agent, not in the LLM tool arguments. `generate_image` is text-only. `edit_image` receives source payloads selected by the agent: all current-turn uploads first, otherwise the latest generated image for the active session. OpenAI performs edits through multipart `/images/edits`; Ollama remains generation-only.

**Tech Stack:** Electron main process, TypeScript, React renderer, existing chat events/session history, OpenAI REST APIs, and direct `node:test` harnesses loaded through Vite because no repository test runner exists.

## Global Constraints

- The LLM chooses `generate_image` or `edit_image`; do not add regex or intent heuristics.
- `generate_image` exposes only a required `prompt`.
- `edit_image` exposes only a required `prompt`; the LLM never sends base64 image arguments.
- Use all current-turn uploaded images for edits/composition.
- If no current-turn upload exists, use the latest generated image in the active session.
- If no source image exists, return a clear upload-or-generate-first error.
- OpenAI image models support editing; Ollama image models remain generation-only.
- Preserve existing image events, previews, model captions, abort signals, usage, and provider routing.
- Do not send production API requests in tests.

---

### Task 1: Define separate built-in tools

**Files:**
- Modify: `src/main/image-gen-tool.ts`
- Test: `scripts/test-image-gen-tool.mjs`

**Interfaces:**
- Produce `GENERATE_IMAGE_NAME = 'generate_image'`.
- Produce `EDIT_IMAGE_NAME = 'edit_image'`.
- Produce `generateImageToolDefinition()` with required `prompt` only.
- Produce `editImageToolDefinition()` with required `prompt` only.
- Preserve `GenerateImageToolResult`.

- [ ] **Step 1: Add failing schema assertions**

Assert that generation and editing have distinct names, each requires `prompt`, neither exposes `images`, and descriptions clearly distinguish generation from editing.

- [ ] **Step 2: Run the focused harness and verify the new assertions fail**

```bash
node scripts/test-image-gen-tool.mjs
```

Expected: failure because `edit_image` and its definition do not exist and `generate_image` still exposes `images`.

- [ ] **Step 3: Implement the two tool definitions**

Keep the existing provider/model discovery and text-only generation path. Remove source-image arguments from `generate_image`; add the editing definition without exposing source payloads.

- [ ] **Step 4: Run the focused harness**

Expected: schema assertions pass and existing text-only routing tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/main/image-gen-tool.ts scripts/test-image-gen-tool.mjs
git commit -m "feat: add separate image generation and edit tools"
```

---

### Task 2: Add edit execution with explicit source images

**Files:**
- Modify: `src/main/openai-image.ts`
- Modify: `src/main/image-gen-tool.ts`
- Test: `scripts/test-openai-image-edit.mjs`
- Test: `scripts/test-image-gen-tool.mjs`

**Interfaces:**
- `editOpenAiImageBase64(model, prompt, images, signal?)` returns `{ b64, usage? }`.
- Add an edit execution function that accepts already-selected source images internally.
- `edit_image` with an Ollama backend returns the exact existing OpenAI-required error.

- [ ] **Step 1: Add failing multipart tests**

Cover one and multiple raw base64 source images, ordered multipart `image` fields, model/prompt/`n=1`, API errors, abort forwarding, malformed base64 rejection, and valid padded/unpadded payloads.

- [ ] **Step 2: Run tests and verify the new edit cases fail**

```bash
node scripts/test-openai-image-edit.mjs
node scripts/test-image-gen-tool.mjs
```

- [ ] **Step 3: Implement OpenAI edit requests**

Validate each raw base64 payload, append one PNG `Blob` per source image to `FormData`, post to `/v1/images/edits`, parse the first output, and preserve existing error/usage/abort behavior.

- [ ] **Step 4: Implement edit-tool routing**

Route `edit_image` to OpenAI edits when the resolved backend is OpenAI. Reject Ollama edit execution without falling back to text generation. Keep `generate_image` text-only.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
node scripts/test-openai-image-edit.mjs
node scripts/test-image-gen-tool.mjs
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/main/openai-image.ts src/main/image-gen-tool.ts scripts
git commit -m "feat: execute image edit tool requests"
```

---

### Task 3: Track and select edit source images

**Files:**
- Modify: `src/main/agent.ts`
- Modify: `src/main/agent-image-boundary.ts`
- Modify: `src/shared/types.ts` only if an event/history type requires it
- Test: `scripts/test-agent-image-attachments.mjs`

**Interfaces:**
- The agent’s edit boundary accepts chat messages, tool-call arguments, and the latest generated-image payload.
- It returns `edit_image` arguments containing internal source images, never exposing them to the LLM schema.

- [ ] **Step 1: Add failing source-selection tests**

Cover:

```text
current user uploads [A, B] + prior generated G => [A, B]
current user uploads none + prior generated G => [G]
no uploads + no generated image => clear no-source error
earlier-turn uploads are excluded
```

- [ ] **Step 2: Run the harness and verify the new tests fail**

```bash
node scripts/test-agent-image-attachments.mjs
```

- [ ] **Step 3: Implement latest-generated-image tracking**

Maintain the latest generated image payload per active turn/session in main-agent state. Update it after direct image generation and successful `edit_image` tool results. Do not persist raw generated payloads in ordinary session history unless required by the existing internal session model; keep UI data and edit source data separate.

- [ ] **Step 4: Implement source priority**

At the actual `edit_image` dispatch boundary:

1. Find the latest user message for the current turn.
2. If it has images, use all of them in order with exact deduplication.
3. Otherwise use the latest generated image.
4. If neither exists, return the clear source-required error.

Ignore any model-supplied image/base64 fields.

- [ ] **Step 5: Run focused tests and verify generated-image updates**

Expected: current uploads override generated images, follow-ups reuse the latest generated output, and each successful edit becomes the next latest source.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent.ts src/main/agent-image-boundary.ts src/shared/types.ts scripts/test-agent-image-attachments.mjs
git commit -m "feat: reuse generated images for follow-up edits"
```

---

### Task 4: Wire both tools into the agent loop

**Files:**
- Modify: `src/main/agent.ts`
- Test: `scripts/test-agent-image-attachments.mjs`

- [ ] **Step 1: Add failing tool-dispatch coverage**

Make the mocked LLM emit `generate_image` and `edit_image` separately. Assert generation receives no source images, while editing receives the selected source payloads and emits the existing `assistant_images` event.

- [ ] **Step 2: Run the harness and verify it fails**

Expected: the current loop handles only `generate_image`.

- [ ] **Step 3: Wire both definitions into tool availability**

Offer both built-in tools whenever image tooling is available and the selected chat model is not itself an image-generation model. Preserve cross-provider availability and provider-safe backend resolution.

- [ ] **Step 4: Add edit dispatch**

Handle `EDIT_IMAGE_NAME` alongside the existing tool flow, emitting status, `tool_start`, `assistant_images`, `tool_result`, errors, model metadata, usage, and abort behavior consistently.

- [ ] **Step 5: Run focused tests and build**

```bash
node scripts/test-agent-image-attachments.mjs
npm run typecheck
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/main/agent.ts scripts
git commit -m "feat: wire image edit tool into agent loop"
```

---

### Task 5: Final verification

**Files:**
- Modify only files required by failing verification.

- [ ] **Step 1: Run all focused harnesses**

```bash
node scripts/test-openai-image-edit.mjs
node scripts/test-image-gen-tool.mjs
node scripts/test-agent-image-attachments.mjs
node scripts/test-tool-call-preview.mjs
```

- [ ] **Step 2: Run project checks**

```bash
npm run check:openai-vision
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 3: Manually verify**

1. Text prompt invokes `generate_image`.
2. Current upload plus edit prompt invokes `edit_image` with all uploads.
3. Follow-up edit without upload uses the latest generated image.
4. A second edit uses the previous edit output.
5. No-source edit returns a clear error.
6. Ollama edit returns the OpenAI-required error.
7. Tool cards show the selected tool name and compact parameters immediately.

- [ ] **Step 4: Record verification**

Append commands, outputs, and any untestable live-provider limitations to `.superpowers/sdd/task-5-report.md`. Do not create an empty commit.
