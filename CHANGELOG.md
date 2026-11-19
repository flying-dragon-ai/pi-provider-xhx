# Changelog

## [0.1.1] - 2026-11-19

- Document what the test suite and the real runs cover, and what they do not.

## [0.1.0] - 2026-11-19

Initial release.

- `xhx` provider speaking the 小浣熊 gateway's OpenAI-compatible Chat Completions surface
  through pi's `openai-completions` implementation.
- OAuth login via the official authorize page and the `office-raccoon://auth/callback`
  redirect, with `state` verification and one-time code exchange.
- JWT-derived refresh scheduling; refresh-token rotation handled.
- Live model catalog from `llm/v2/model_catalog` with a six-model offline fallback.
- Gateway compatibility flags: no `store`, no `developer` role, no `reasoning_effort`,
  `max_tokens` instead of `max_completion_tokens`, and a one-shot retry without
  `stream_options` when the gateway rejects it.
- Commands: `/xhx`, `/xhx-balance`, `/xhx-checkin`, `/xhx-models`.
- `XHX_ACCESS_TOKEN` and `XHX_ORIGIN` environment overrides.
