# User image attachment preview

Date: 2026-09-25

## Goal

Show attached images inside the user's prompt message using the original image
data, visually constrained by the browser without generating resized thumbnail
files.

## Design

- Add `images?: string[]` to the user `UiMessage` type for image data URLs.
- When composing a message, preserve the original image data URLs for the user
  message display while continuing to send the existing raw image payloads to
  the model.
- Render user images with an `<img>` element constrained by CSS
  `max-width`, `max-height`, and `object-fit: contain`.
- Do not create resized thumbnails or alter the original image data.
- Reuse the existing lightbox for click-to-open full-size viewing where the
  current component structure allows it.
- Keep text/file attachment labels unchanged.
- Avoid copying image data into the persisted model history; this is a UI
  message presentation field.

## Data flow

The composer already has attachment data URLs and sends raw image payloads.
The UI send payload will additionally carry the image data URLs. `App.tsx`
stores them on the user `UiMessage`, and `Chat.tsx` renders them before the
user's text. Existing history conversion continues to use the raw `ChatMessage`
image fields for model requests.

## Verification

- Send one image with text and see the image constrained inside the user bubble.
- Send multiple images and see each image rendered.
- Confirm original aspect ratios are preserved.
- Confirm image clicks open the existing lightbox if supported.
- Confirm text/file labels remain visible.
- Confirm model requests still receive the original image payloads.
- Run `npm run typecheck`, `npm run build`, and linter checks.
