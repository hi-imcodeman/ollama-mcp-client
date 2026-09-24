# Token usage tooltip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show turn-summed token usage on each assistant reply with an expanded tooltip (input, output, cached, reasoning) for OpenAI and Ollama without changing the inline context bar layout.

**Architecture:** Add `TokenUsageBreakdown` on `assistant_done` and assistant `UiMessage`; accumulate usage in `agent.ts` across all `chatStream` calls in a turn; parse full OpenAI SSE `usage`; format multiline tooltips in `MessageMeta`.

**Tech Stack:** TypeScript, Electron main/renderer, existing chat event pipeline.

## Global Constraints

- Inline summary stays `contextUsed / contextLimit` (+ bar + %) when `contextLimit > 0`.
- Tooltip shows full breakdown when `tokenUsage` is present; hide optional lines when 0/undefined.
- Sum usage across all model calls in one user turn (tool loop + wrap-up).
- OpenAI image turns: attach `tokenUsage` only when API returns usage.
- Do not add live streaming token UI or cost ($) estimates.
- Run `npm run typecheck` after each task.

---

### Task 1: Types and merge helpers

**Files:**
- Create: `src/shared/tokenUsage.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces: `TokenUsageBreakdown`, `emptyTokenUsage`, `mergeTokenUsage`, `hasTokenUsageData`

- [ ] **Step 1: Add `TokenUsageBreakdown` to `types.ts` and extend `assistant_done` + assistant `UiMessage`**

- [ ] **Step 2: Implement merge helpers in `tokenUsage.ts`**

```ts
export function emptyTokenUsage(provider: 'ollama' | 'openai'): TokenUsageBreakdown {
  return {
    provider,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0
  }
}

export function mergeTokenUsage(
  acc: TokenUsageBreakdown,
  delta: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedPromptTokens?: number
    reasoningTokens?: number
    ollamaPromptEval?: number
    ollamaEval?: number
  }
): TokenUsageBreakdown {
  const next = { ...acc }
  next.promptTokens += delta.promptTokens ?? 0
  next.completionTokens += delta.completionTokens ?? 0
  next.totalTokens += delta.totalTokens ?? (delta.promptTokens ?? 0) + (delta.completionTokens ?? 0)
  next.cachedPromptTokens = (next.cachedPromptTokens ?? 0) + (delta.cachedPromptTokens ?? 0)
  next.reasoningTokens = (next.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0)
  if (delta.ollamaPromptEval != null) {
    next.ollamaPromptEval = (next.ollamaPromptEval ?? 0) + delta.ollamaPromptEval
  }
  if (delta.ollamaEval != null) {
    next.ollamaEval = (next.ollamaEval ?? 0) + delta.ollamaEval
  }
  return next
}
```

- [ ] **Step 3: Run `npm run typecheck`**

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/tokenUsage.ts
git commit -m "feat: add TokenUsageBreakdown types and merge helpers"
```

---

### Task 2: OpenAI stream usage parsing

**Files:**
- Modify: `src/main/openai-client.ts`
- Modify: `src/main/llm/types.ts`

**Interfaces:**
- Produces: `OpenAiUsageDetails`, extended `OpenAiStreamResult.usage`

- [ ] **Step 1: Define parsed usage type and extend SSE handler**

Parse on each chunk with `usage`:

```ts
export interface OpenAiUsageDetails {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens: number
  reasoningTokens: number
}
```

Accumulate last non-empty usage from stream (final chunk). Return on `OpenAiStreamResult` as `usage?: OpenAiUsageDetails`.

- [ ] **Step 2: Extend `LlmChatStreamResult` with optional `usage` for OpenAI path**

- [ ] **Step 3: Map Ollama stream counts in `ollama-provider` / result type as optional `ollamaUsage`**

- [ ] **Step 4: typecheck + commit**

---

### Task 3: Agent turn accumulator

**Files:**
- Modify: `src/main/agent.ts`

- [ ] **Step 1: At turn start, `let turnUsage = emptyTokenUsage(effective)`**

- [ ] **Step 2: After each `llm.chatStream` (loop + wrap-up), merge:**

OpenAI: from `result.usage`  
Ollama: from `promptEvalCount` / `evalCount`

- [ ] **Step 3: Pass `tokenUsage: hasData ? turnUsage : undefined` on `assistant_done`**

- [ ] **Step 4: OpenAI image path — parse usage from Responses/Images JSON when present; merge once before `assistant_images` or attach on a follow-up done path if needed**

- [ ] **Step 5: typecheck + commit**

---

### Task 4: Renderer pipeline

**Files:**
- Modify: `src/renderer/src/lib/backgroundChatEvents.ts`
- Modify: `src/renderer/src/App.tsx` (if assistant_done handled inline)

- [ ] **Step 1: Copy `event.tokenUsage` onto assistant message in `assistant_done` handler**

- [ ] **Step 2: typecheck:web + commit**

---

### Task 5: MessageMeta tooltip formatter

**Files:**
- Create: `src/renderer/src/lib/formatTokenUsageTooltip.ts`
- Modify: `src/renderer/src/components/MessageMeta.tsx`
- Modify: `src/renderer/src/components/Chat.tsx` (pass `tokenUsage` prop if needed)

- [ ] **Step 1: Implement `formatContextTooltip({ contextUsed, contextLimit, tokenUsage, multiCallTurn? })`**

Returns multiline string for `title` attribute.

- [ ] **Step 2: Add optional `tokenUsage` to `MessageMetaProps`; use formatter on context span `title`**

- [ ] **Step 3: Pass `tokenUsage` from Chat message meta for assistant bubbles**

- [ ] **Step 4: Manual smoke: OpenAI + Ollama reply tooltips**

- [ ] **Step 5: typecheck + commit**

```bash
git commit -m "feat: show detailed token usage in MessageMeta tooltips"
```

---

## Plan self-review

| Spec requirement | Task |
| --- | --- |
| Inline summary unchanged | Task 5 (tooltip only) |
| OpenAI cached/reasoning | Task 2, 3 |
| Ollama prompt/generated | Task 3, 5 |
| Turn sum | Task 3 |
| Image when API provides | Task 3 |
| Both providers | Tasks 3–5 |

No TBD placeholders.
