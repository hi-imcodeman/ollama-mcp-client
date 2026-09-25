# User image attachment preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Display original attached images inside user prompt bubbles with browser-constrained sizing and no generated thumbnails.

**Architecture:** Extend the user-facing `UiMessage` with image data URLs separate from model `ChatMessage` history. Pass the existing attachment data URLs through the send callback, store them on the user UI message, and render them in `Chat.tsx` using constrained `<img>` elements. Keep raw model payloads and persisted model history unchanged.

**Tech Stack:** TypeScript, React, Electron renderer, existing attachment and lightbox components.

## Global Constraints

- Show previews for image attachments only.
- Render the original image data with CSS sizing; do not generate resized thumbnails.
- Preserve original aspect ratio with `object-fit: contain`.
- Keep text/file attachment labels unchanged.
- Do not add image data to persisted model history beyond the existing raw `ChatMessage` flow.
- Preserve existing image payloads sent to LLM providers.
- Run `npm run typecheck`, `npm run build`, and linter checks.

---

## File map

- Modify `src/shared/types.ts`: add optional image data to user `UiMessage`.
- Modify `src/renderer/src/components/Chat.tsx`: accept image data in send payload and render user previews.
- Modify `src/renderer/src/App.tsx`: store image data on newly created user UI messages.
- Modify `src/renderer/src/lib/backgroundChatEvents.ts` only if background user-message handling requires the same field.

### Task 1: Add image data to user UI messages

**Files:**
- Modify: `src/shared/types.ts`

**Interfaces:**
- Add `images?: string[]` to the `UiMessage` user variant.
- Preserve assistant `images?: string[]` and model `ChatMessage.images?: string[]` semantics.

- [ ] **Step 1: Run baseline typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Add the optional user image field**

In the `kind: 'user'` variant, add:

```ts
/** Original image data URLs shown in the prompt bubble. */
images?: string[]
```

Do not modify `ChatMessage` or persistence stripping behavior.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: store user image preview data"
```

### Task 2: Pass and render original image data

**Files:**
- Modify: `src/renderer/src/components/Chat.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Extend Chat `onSend` payload with `images?: string[]`.
- Store `payload.images` on the newly created user `UiMessage`.

- [ ] **Step 1: Extend the Chat send callback**

In `Chat.tsx`, update the `onSend` prop:

```ts
onSend: (payload: {
  content: string
  images?: string[]
  attachmentLabels?: string[]
  invokedSkill?: string
}) => void
```

The composer already receives `built.images`; include it in the callback without changing the model payload.

- [ ] **Step 2: Store images in the App user message**

In `App.tsx`, when constructing `userMsg`, add:

```ts
images: payload.images?.map((image) =>
  image.startsWith('data:') ? image : `data:image/png;base64,${image}`
)
```

This is display-only UI state. The separately constructed `ChatMessage` continues using raw `payload.images`.

- [ ] **Step 3: Render constrained user images**

In the `m.kind === 'user'` branch of `Chat.tsx`, render images before the text:

```tsx
{m.images && m.images.length > 0 && (
  <div className="mb-2 flex flex-wrap gap-2">
    {m.images.map((src, index) => (
      <img
        key={`${m.id}-image-${index}`}
        src={src}
        alt="Attached image"
        className="max-h-40 max-w-40 rounded-lg object-contain"
      />
    ))}
  </div>
)}
```

Use CSS constraints only; do not use canvas, blob conversion, or image resizing.

- [ ] **Step 4: Keep text/file labels**

Leave the existing `attachmentLabels` rendering in place after or alongside the image preview. Do not replace file labels with images.

- [ ] **Step 5: Run typecheck and lints**

Run: `npm run typecheck` and inspect diagnostics for `src/shared/types.ts`, `src/renderer/src/App.tsx`, and `src/renderer/src/components/Chat.tsx`.

Expected: PASS with no new diagnostics.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/renderer/src/App.tsx src/renderer/src/components/Chat.tsx
git commit -m "feat: show attached images in user messages"
```

### Task 3: Verify persistence and model payload regressions

**Files:**
- Modify only if verification finds a defect.

- [ ] **Step 1: Verify model payload separation**

Inspect `handleSend` and confirm:

```ts
const userMsg: UiMessage = {
  kind: 'user',
  images: displayImages
}

const userChatMessage: ChatMessage = {
  role: 'user',
  images: payload.images
}
```

The user preview field may contain data URLs, but model history must keep the existing raw image payloads and `stripHeavyHistory` must not be bypassed.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 3: Manual smoke checks**

1. Send one image with text; confirm it appears in the user bubble at constrained dimensions.
2. Send multiple images; confirm each appears with aspect ratio preserved.
3. Confirm text/file attachment labels remain visible.
4. Confirm the image payload still reaches an OpenAI vision model.
5. Reload the session and confirm no oversized image payload was added to model history.

- [ ] **Step 4: Check diagnostics and working tree**

Inspect linter diagnostics for changed files and run:

```bash
git status --short
```

Expected: no linter errors and only intended changes.
