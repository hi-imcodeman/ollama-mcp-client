# OpenAI vision capability detection

Date: 2026-09-25

## Goal

Allow image attachments to OpenAI chat models that support visual input, using
a maintainable static model-family allowlist. Avoid rejecting models merely
because OpenAI's model catalog does not expose a reliable vision-capability
field.

## Detection rules

The shared OpenAI vision classifier returns `yes` for:

- Model IDs containing `vision`.
- `gpt-4o` and `gpt-4o-*`.
- `gpt-4.1` and `gpt-4.1-*`.
- `gpt-4.5` and `gpt-4.5-*`.
- Any `gpt-<major>` family where `major > 5`, including suffixes.
- `gpt-5` and `gpt-5-*`.
- `o1`, `o1-*`, `o3`, `o3-*`, `o4-mini`, and matching future `o` reasoning
  families known to accept image input.

Known image-generation-only models remain excluded from chat selection and do
not become vision chat models.

Unrecognized OpenAI model IDs return `unknown`. The UI should warn only when
support is definitively `no`, allowing uncertain models to attempt image input
and receive an API error if unsupported.

## Architecture

Create one shared classifier in `src/shared/openai-models.ts` and use it from:

- `src/main/llm/openai-provider.ts` for model capabilities/tags and
  `detectVisionSupport`.
- Renderer model metadata only through the model capabilities/tags already
  returned by the provider.

Keep OpenAI image attachments encoded as existing `image_url` data URLs. No
per-message API probe is added.

## Verification

- `gpt-4o`, `gpt-4.1`, `o3`, `o4-mini`, and `gpt-6` classify as vision-capable.
- `gpt-5.6-sol` classifies according to the explicit GPT-major rule.
- Unknown model IDs remain `unknown`.
- Image-generation models do not appear as chat models.
- Run `npm run typecheck`, `npm run build`, and linter checks.
