# Internal image tool invocation design

Date: 2026-09-24

## Problem

The agent currently contains two heuristic paths that can invoke image
generation without an actual tool call:

- A regex treats phrases such as “generate image prompts” as requests to
  generate an image.
- A thinking-text detector infers that the model intended to call
  `generate_image`.

These heuristics can misclassify text requests and bypass the LLM's tool
selection.

## Goal

Make `generate_image` an internal built-in tool selected only by the LLM. The
tool remains available alongside skills and MCP tools, but the agent must not
force or infer calls from user text or model thinking.

## Design

1. Remove `isExplicitImageRequest` and the direct image-tool invocation branch.
2. Remove `modelPlannedImageToolCall` and inferred tool-call execution.
3. Keep exposing the built-in `generate_image` definition when an image backend
   is available.
4. Strengthen the tool description:
   - Use only when the user wants an actual image generated.
   - Do not use for writing image prompts, scene descriptions, or image ideas.
5. Execute image generation only when the provider returns a real
   `generate_image` tool call.
6. Preserve provider-independent backend selection, image events, model-name
   metadata, abort behavior, and existing direct image-model generation.

## Tool failure behavior

The existing tool execution path remains responsible for failures. It emits
the tool result and returns the error to the model through the normal tool
message flow, allowing the LLM to explain the failure or continue rather than
having a heuristic path terminate the turn.

## Verification

- “Generate image prompts for all scenes” must produce a normal text response
  and no `generate_image` tool event.
- “Generate an image of a mountain” must invoke `generate_image` when an image
  backend is available.
- Model thinking that mentions `generate_image` without a structured tool call
  must not trigger image generation.
- Run `npm run typecheck`, `npm run build`, and linter checks.
