# Changelog

## [0.4.1] - 2026-11-24

- Reject HTTP 200 business errors, missing choices, malformed completion payloads, and error
  `finish_reason` values instead of returning a successful empty answer.
- Serialize concurrent requests through the minimum-interval limiter and make limiter waits
  abortable. Honor injected fetch implementations, request timeouts, provider environment
  overrides, model headers, `toolChoice`, sampling parameters, and asynchronous response hooks.
- Fold system-message and tool updates before each request, preserve malformed tool arguments
  for validation, and account for cache-read/cache-write/reasoning tokens correctly.
- Validate OAuth callback state before reporting success and keep listening for the real
  callback after a mismatch. Clean up callback waiters on timeout/cancellation, honor an
  already-aborted login, and never extend short-lived credentials beyond JWT expiry.
- Reject malformed successful account responses and avoid coercing blank numeric fields or
  sub-unit catalog limits to zero.
- Require `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` 1.5.2 or newer so
  every runtime API used by the extension is covered by the declared peer range.
- Remove the unused SSE/`stream_options` implementation left over from the streaming adapter,
  tighten compiler checks, synchronize the README, and expand the suite from 54 to 68 tests.

## [0.4.0] - 2026-11-23

- Call `/llm/v1/chat/completions` instead of `/llm/v2/chat/completions`. The v2 endpoint is
  behind a risk control that blocks accounts using it from a non-official client (`429`,
  `code 200108`); v1 serves the same OpenAI shape without that gate.
- The v1 streaming path is broken upstream (`invalid upstream stream response`), so the
  extension calls the non-streaming path and synthesizes pi's event stream from the response.
  Text now arrives in one block; tool calls, thinking, usage, and cancellation are unchanged.
- Drop the `openai` SDK from the request path: message conversion, tool conversion, and the
  response mapping are implemented in the extension, so an interrupted install of that package
  can no longer break chat.

## [0.3.2] - 2026-11-23

- Send the header set the official client sends (`X-Org-Code`, `X-Raccoon-Language`) and a
  browser user agent instead of identifying the extension, and add `verbose: true` to the
  body. The gateway's risk control keys on the difference between first-party and third-party
  traffic.

## [0.3.1] - 2026-11-23

- Keep requests in the shape the official desktop client uses: send its client headers, cap
  the output reservation at 16K instead of the catalog's 100K, and space requests at least
  400 ms apart. The gateway's risk control flags accounts that look like a scraper.
- Explain a `429` / `code 200108` block instead of surfacing the raw upstream message.

## [0.3.0] - 2026-11-19

- Bind pi thinking levels to the gateway: read `params.raccoon_thinking` from the catalog,
  mark those models reasoning-capable, and send the mapped `raccoon_thinking` value with each
  request. `/thinking`, `--thinking`, and the model selector now reach the upstream.
- Explain an interrupted `openai` SDK install instead of surfacing a bare module error.

## [0.2.0] - 2026-11-19

- Login is now a browser OAuth loopback flow: the extension binds a throwaway server on
  127.0.0.1 and the authorize page redirects straight back to it, so there is nothing to
  copy. The paste flow remains as a fallback when the loopback is unreachable.
- Read the account id from the IAM token `sub` claim.
- Refresh the fallback model list to the current live catalog (seven models, real context and
  output limits).
- Verified end to end against the live gateway with a real account: login, chat, tool calls,
  catalog refresh, balance.

## [0.1.3] - 2026-11-19

- Drop unparseable SSE frames instead of letting one kill the whole answer.
- Cover empty responses, malformed frames, split surrogate pairs, mid-stream disconnects,
  and image input in the test suite.

## [0.1.2] - 2026-11-19

- Add a troubleshooting section for the failures users actually hit.

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
