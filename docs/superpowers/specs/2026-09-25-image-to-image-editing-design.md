# Image-to-Image Editing Design

## Goal

Support image editing requests in the existing built-in `generate_image` flow,
including multiple uploaded source images, while preserving text-to-image
generation and rejecting unsupported Ollama image-edit requests clearly.

## Scope

- One built-in `generate_image` tool remains the only image tool.
- The LLM decides whether the request is text-to-image or image-to-image.
- Uploaded image attachments are passed to the tool execution when present.
- OpenAI image models use the Images Edits API for image-to-image requests.
- Ollama image models remain text-to-image only.
- Multiple source images are supported for OpenAI edits.
- Existing generated-image rendering and model captions remain unchanged.

## Design

### Tool contract

Extend `generate_image` with an optional `images` array. Each item is the raw
base64 image payload already present in the current turn. The tool description
will state that `images` must be included when editing or combining uploaded
images, and omitted for ordinary text-to-image generation.

The agent will make the current turn's attached images available to the tool
execution without requiring the model to reproduce large base64 values in its
tool-call arguments. The execution layer combines the model-provided optional
images with the current turn attachments, deduplicating by exact payload.

### Backend routing

`runGenerateImageTool` continues to resolve the configured image backend.

- No source images: use the existing OpenAI generation or Ollama generation
  path.
- Source images with an OpenAI backend: call `POST /v1/images/edits` using
  multipart form data, with one `image` part per source image, the prompt, and
  `n=1`. Return the first `b64_json` result.
- Source images with an Ollama backend: return a tool failure explaining that
  image editing requires an OpenAI image model. Do not silently convert the
  request to text-to-image.

The OpenAI edit helper will use the selected OpenAI image model and preserve
the existing API-key, abort-signal, and error-formatting conventions.

### Data flow

1. Renderer reads and optimizes attachments using the existing attachment
   pipeline, preserving the original preview separately from the API payload.
2. Renderer sends image payloads in the existing `ChatSendPayload.messages`
   structure.
3. Agent validates image capability for the chat model as it does today.
4. When the LLM emits `generate_image`, the agent passes the current turn's
   image payloads into image-tool execution.
5. The image tool routes to OpenAI edits or rejects unsupported Ollama edits.
6. The existing `assistant_images` event renders the edited result and model
   name.

### Validation and errors

- Empty or malformed image payloads produce a clear tool error.
- An empty prompt remains invalid.
- Multiple images are sent as separate multipart `image` fields.
- OpenAI API errors use the existing formatted error helper.
- Aborts propagate through the existing `AbortSignal`.
- Text-only generation behavior is unchanged.

## Testing

Add focused tests for:

1. OpenAI text-only generation uses the existing generation endpoint.
2. OpenAI one-image editing sends multipart image data to `/images/edits`.
3. OpenAI multi-image editing sends every source image.
4. Ollama image editing returns a clear unsupported-operation failure.
5. The tool schema exposes optional images while keeping prompt required.
6. Tool execution retains existing model metadata and output behavior.

Run `npm run typecheck`, `npm run build`, and `git diff --check` after
implementation. No production API keys or external image requests are needed
for the focused tests.
