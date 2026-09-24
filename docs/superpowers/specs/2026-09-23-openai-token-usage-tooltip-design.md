# Token usage tooltip (OpenAI + Ollama)

Date: 2026-09-23

## Problem

Assistant replies show a compact **context used / limit** line in `MessageMeta`, with a simple tooltip. OpenAI Chat Completions can return rich `usage` (including **cached prompt tokens** and **reasoning tokens**), but the app only adds `prompt_tokens + completion_tokens` into `contextUsed` and does not surface cache or other details. Ollama exposes `prompt_eval_count` and `eval_count` per stream, but the tooltip does not break them out. Multi-step tool turns can invoke the model several times; users want **one turn total**, not the last call only.

## Goal

Keep the **existing inline summary** (`used / limit` + mini bar + %) on each assistant message. **Expand the hover tooltip** to show a full token breakdown for **OpenAI and Ollama**, including cached input tokens when present. **Sum usage across all model calls** in a single user turn (tool loop + wrap-up). For **OpenAI image** turns, show usage **only when the API returns it**; otherwise omit the breakdown.

## Non-goals

- Live/updating token counts during streaming (only on finished reply)
- Billing/cost estimation ($)
- Changing the footer context meter layout (option C was declined)
- Telegram-specific UI (same events/data as desktop)

## Decisions (brainstorming)

| Topic | Choice |
| --- | --- |
| Placement | Inline summary unchanged; details in tooltip |
| Providers | Rich tooltip for OpenAI and Ollama |
| Tool loop | Sum all model calls in the turn |
| Image gen | Show usage when API provides it; else omit |

## Data model

Add to `src/shared/types.ts`:

```ts
export interface TokenUsageBreakdown {
  provider: 'ollama' | 'openai'
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens?: number
  reasoningTokens?: number
  /** Ollama sums (same as prompt/completion when mapped). */
  ollamaPromptEval?: number
  ollamaEval?: number
}
```

Extend:

- `ChatEvent` variant `assistant_done` with optional `tokenUsage?: TokenUsageBreakdown`
- Assistant branch of `UiMessage` with optional `tokenUsage?: TokenUsageBreakdown`

Keep existing `contextUsed`, `contextLimit`, `tokensPerSec` on `assistant_done` / UI messages for the inline bar and speed line.

### Accumulation rules

At **turn start**, initialize an empty accumulator.

After **each** successful `chatStream` (every tool iteration and wrap-up):

**OpenAI** — merge SSE final `usage` (requires `stream_options.include_usage`):

| API field | Accumulator |
| --- | --- |
| `prompt_tokens` | add to `promptTokens` |
| `completion_tokens` | add to `completionTokens` |
| `total_tokens` | add to `totalTokens` (or recompute from sums) |
| `prompt_tokens_details.cached_tokens` | add to `cachedPromptTokens` |
| `completion_tokens_details.reasoning_tokens` | add to `reasoningTokens` |

**Ollama** — merge stream result:

| Field | Accumulator |
| --- | --- |
| `prompt_eval_count` | add to `promptTokens` and `ollamaPromptEval` |
| `eval_count` | add to `completionTokens` and `ollamaEval` |
| total | `promptTokens + completionTokens` |

Set `provider` from effective LLM provider for the turn.

On **`assistant_done`**, attach final `tokenUsage` if any model call reported counts; otherwise omit.

**Image generation (OpenAI):** After Images or Responses image call, map any usage object returned by the API into the same structure and attach on `assistant_done` / image completion path. If no usage, do not set `tokenUsage`.

`contextUsed` on `assistant_done` remains the occupancy metric used for compaction/UI meter (existing behavior); it may equal or relate to `totalTokens` but is not replaced by this feature.

## Main process changes

| Area | Change |
| --- | --- |
| `openai-client.ts` | Extend SSE parser to capture full `usage` object on final chunk; return structured usage from `openAiChatStream` |
| `llm/types.ts` / providers | Pass usage through `LlmChatStreamResult` |
| `agent.ts` | Turn-level accumulator; merge after each stream; emit on `assistant_done` |
| `openai-image.ts` | Optional usage extraction from Responses/Images responses |

Helper in shared or main:

```ts
function mergeTokenUsage(acc: TokenUsageBreakdown, delta: Partial<TokenUsageBreakdown>): TokenUsageBreakdown
function emptyTokenUsage(provider: 'ollama' | 'openai'): TokenUsageBreakdown
```

## Renderer changes

**`backgroundChatEvents.ts` / `App.tsx`:** When handling `assistant_done`, copy `tokenUsage` onto the assistant `UiMessage`.

**`MessageMeta.tsx`:**

- Inline row: unchanged (`contextUsed / contextLimit` when limit &gt; 0).
- **`title` tooltip** (multiline string or structured render):
  - Line 1: Context window when this reply finished: `{used} / {limit} tokens ({pct}%)`
  - If `tokenUsage` present:
    - **OpenAI:** Input tokens; Cached input tokens (if &gt; 0); Output tokens; Reasoning tokens (if &gt; 0); Total tokens; footnote if multi-call turn
    - **Ollama:** Prompt tokens; Generated tokens; Total; same footnote when applicable
  - If no `tokenUsage` but Ollama/OpenAI context only: keep current single-line tooltip

Hide optional lines when value is 0 or undefined (except total).

## Error handling

- Missing usage on a stream chunk: skip merge for that call; do not fail the turn.
- Partial usage object: treat missing detail fields as 0.
- Malformed SSE usage: ignore; log at debug in main if needed.

## Testing

Manual:

1. OpenAI `gpt-4.1-mini`, single reply — tooltip shows input/output/total; no cached line if 0.
2. Repeat similar prompt — cached input &gt; 0 when API caches.
3. OpenAI with MCP tools — tooltip total &gt; single-call usage; footnote visible.
4. Ollama chat — prompt vs generated lines match eval counts.
5. OpenAI image model — usage shown when API returns it; no token breakdown when absent.

Automated: `npm run typecheck` after changes.

## Future (out of scope)

- Per-iteration lines inside tooltip
- Cost from pricing table
- Persist `tokenUsage` in session export
