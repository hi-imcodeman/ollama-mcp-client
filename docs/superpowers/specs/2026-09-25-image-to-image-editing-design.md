# Image Generation and Image Editing Design

## Goal

Support LLM-selected text-to-image generation and image-to-image editing,
including follow-up edits that reuse the latest available image and multiple
uploaded source images.

## Scope

- Use two built-in tools: `generate_image` for text-to-image and `edit_image`
  for image-to-image operations.
- The LLM decides which tool to invoke; no regex or intent heuristics are used.
- `edit_image` receives source images automatically from the agent.
- OpenAI image models use the Images Edits API for image-to-image requests.
- Ollama image models remain text-to-image only.
- Multiple source images are supported for OpenAI edits.
- Source priority is all current-prompt uploaded images, otherwise the latest
  generated image in the active session.
- If no edit source exists, `edit_image` returns a clear error.
- Existing generated-image rendering and model captions remain unchanged.

## Design

### Tool contracts

`generate_image` accepts only a required text `prompt` and is used for
text-to-image requests.

`edit_image` accepts only a required text `prompt`. It does not expose an
image/base64 argument to the LLM. The agent supplies source images
automatically, so the LLM never needs to reproduce large image payloads.

### Backend routing

`runGenerateImageTool` is split into generation and editing execution paths,
while preserving configured image-model routing.

- `generate_image`: use the existing OpenAI generation or Ollama generation
  path, with no source images.
- `edit_image` with an OpenAI backend: call `POST /v1/images/edits` using
  multipart form data, with one `image` part per source image, the prompt, and
  `n=1`. Return the first `b64_json` result.
- `edit_image` with an Ollama backend: return a tool failure explaining that
  image editing requires an OpenAI image model. Never silently convert editing
  into text-to-image generation.

The OpenAI edit helper will use the selected OpenAI image model and preserve
the existing API-key, abort-signal, and error-formatting conventions.

### Data flow

1. Renderer reads and optimizes attachments using the existing attachment
   pipeline, preserving the original preview separately from the API payload.
2. Renderer sends image payloads in the existing `ChatSendPayload.messages`
   structure.
3. The agent maintains the latest generated image for the active session
   internally for follow-up turns.
4. The LLM receives both built-in tool definitions and chooses
   `generate_image` or `edit_image`.
5. When `edit_image` is emitted, the agent selects all current-prompt images,
   or falls back to the latest generated image.
6. The image tool routes to OpenAI edits or rejects unsupported Ollama edits.
7. The existing `assistant_images` event renders the result and model
   name.

### Validation and errors

- Empty or malformed image payloads produce a clear tool error.
- An empty prompt remains invalid.
- `edit_image` without a current upload or prior generated image produces a
  clear “upload or generate an image first” error.
- Multiple images are sent as separate multipart `image` fields.
- OpenAI API errors use the existing formatted error helper.
- Aborts propagate through the existing `AbortSignal`.
- Text-only generation behavior is unchanged.

## Testing

Add focused tests for:

1. `generate_image` exposes only a required prompt and uses the generation
   endpoint.
2. `edit_image` exposes only a required prompt.
3. One uploaded image is selected for an edit when present.
4. Multiple current-prompt images are all selected for composition.
5. The latest generated image is selected when no image is uploaded.
6. An edit without any source image returns a clear error.
7. OpenAI edits send multipart image data to `/images/edits`.
8. Ollama image editing returns a clear unsupported-operation failure.
9. Tool execution retains existing model metadata and output behavior.

Run `npm run typecheck`, `npm run build`, and `git diff --check` after
implementation. No production API keys or external image requests are needed
for the focused tests.
