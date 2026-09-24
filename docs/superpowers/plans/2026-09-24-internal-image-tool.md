# Internal image tool invocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove heuristic image-generation routing and rely exclusively on structured LLM calls to the internal `generate_image` tool.

**Architecture:** Keep the built-in tool definition, provider-independent image backend selection, and normal tool dispatch. Delete user-text regex routing and thinking-text inference so only structured `tool_calls` can execute image generation. Strengthen the tool description to distinguish actual image creation from writing prompts or describing scenes.

**Tech Stack:** TypeScript, Electron main process, existing Ollama/OpenAI adapters, React renderer unchanged.

## Global Constraints

- `generate_image` remains an internal built-in tool alongside skills and MCP tools.
- Only structured LLM `generate_image` tool calls may execute image generation.
- Do not infer tool calls from user text or model thinking text.
- “Generate image prompts for all scenes” must remain a normal text request.
- Actual image requests must still work when an image backend is available.
- Preserve provider-independent backend selection, model-name metadata, events, abort behavior, and direct image-model generation.
- Do not add a fake MCP server or a new test runner.

---

## File map

- Modify `src/main/agent.ts`: remove regex and thinking heuristics and their forced execution branches.
- Modify `src/main/image-gen-tool.ts`: clarify the built-in tool description.
- No renderer or shared-type changes are expected.

### Task 1: Remove heuristic routing

**Files:**
- Modify: `src/main/agent.ts`

**Interfaces:**
- Preserve `runAgentTurn(payload: ChatSendPayload): Promise<void>`.
- Preserve structured `generate_image` dispatch in the normal tool-call loop.

- [ ] **Step 1: Capture the current behavior**

Run:

```bash
rg -n "isExplicitImageRequest|modelPlannedImageToolCall|inferredImageToolCall|lastUserPrompt" src/main/agent.ts
```

Expected: matches for the user-text regex branch and thinking inference branch.

- [ ] **Step 2: Remove the user-text regex helper**

Delete `isExplicitImageRequest()` and the related `lastUserPrompt` calculation. Do not change the normal prompt construction or direct image-model early return.

- [ ] **Step 3: Remove forced tool execution**

Delete the block beginning with:

```ts
if (offerImageTool && lastUserPrompt && isExplicitImageRequest(lastUserPrompt)) {
```

This ensures text such as “generate image prompts” reaches the selected LLM normally.

- [ ] **Step 4: Remove thinking-text inference**

Delete `modelPlannedImageToolCall()`, `thinkingForDetection`, and `inferredImageToolCall`. Remove the `onChunk` accumulation/check and delete the post-stream block beginning with:

```ts
if (
  toolCalls.length === 0 &&
  offerImageTool &&
  inferredImageToolCall &&
  lastUserPrompt
) {
```

Do not alter handling of actual `toolCalls`.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS with no unused-variable or missing-reference errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent.ts
git commit -m "fix: rely on structured image tool calls"
```

### Task 2: Clarify the internal tool contract

**Files:**
- Modify: `src/main/image-gen-tool.ts`

**Interfaces:**
- Preserve `generateImageToolDefinition(): OllamaTool`.
- Preserve the exact tool name `generate_image` and argument `{ prompt: string }`.

- [ ] **Step 1: Update the tool description**

Use wording that explicitly scopes the tool:

```ts
description:
  'Generate an actual image from a text prompt using the configured image model. Use this only when the user wants an image created or generated. Do not use it for writing image prompts, describing scenes, or suggesting image ideas.'
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/image-gen-tool.ts
git commit -m "docs: clarify generate image tool intent"
```

### Task 3: Verify intent routing and regressions

**Files:**
- No production files unless verification identifies a defect.

- [ ] **Step 1: Verify heuristic symbols are gone**

Run:

```bash
rg -n "isExplicitImageRequest|modelPlannedImageToolCall|inferredImageToolCall|Calling generate_image" src/main/agent.ts
```

Expected: no matches. The normal structured tool dispatch still contains `GENERATE_IMAGE_NAME`.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 3: Manual smoke checks**

With an OpenAI chat model and an available image backend:

1. Send `can you generate image prompts for all the scenes?`; confirm no `generate_image` tool event and a normal text response.
2. Send `generate an image of a mountain at sunset`; confirm the LLM emits a structured `generate_image` call and the image is displayed.
3. Confirm model-thinking text mentioning `generate_image` alone does not execute the tool.

- [ ] **Step 4: Check diagnostics and working tree**

Use the IDE linter on `src/main/agent.ts` and `src/main/image-gen-tool.ts`, then run:

```bash
git status --short
```

Expected: no linter errors and only intended commits/files changed.
