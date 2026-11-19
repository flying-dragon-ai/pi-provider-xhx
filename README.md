# pi-provider-xhx

A [pi](https://pi.dev) extension that connects pi to **小浣熊** (SenseTime Raccoon) — the
`xiaohuanxiong.com` web/desktop gateway — as a first-class provider.

No local proxy process. The extension speaks the gateway's OpenAI-compatible Chat Completions
surface directly, holds the OAuth credentials, refreshes them through pi's auth layer, and
streams through pi's own `openai-completions` implementation.

```bash
pi install npm:pi-provider-xhx
```

```bash
pi --provider xhx --model sn-glm-5-3-flash
```

Inside pi:

```text
/login xhx
/model sn-glm-5-3-flash
```

## Login

`/login xhx` opens the official authorize page:

```text
https://xiaohuanxiong.com/code/authorize?login_source=desktop&appname=办公小浣熊客户端&state=…
```

Sign in with WeChat, SMS, or password. The page then redirects to a custom scheme:

```text
office-raccoon://auth/callback?code=…&state=…
```

Your browser cannot open that scheme — that is expected. Copy the whole address out of the
address bar and paste it into the prompt. The extension verifies `state`, exchanges the
one-time code at `auth/v1/login_with_authorization_code`, and stores the credentials in
`~/.pi/agent/auth.json`.

Pasting only the `code` also works; the `state` check is skipped in that case.

### Token lifetime

The access token is a JWT. The extension reads `exp` and schedules a refresh five minutes
before it, so a request never races expiry. The refresh token is rotated when the upstream
rotates it and kept when it does not.

Do not run a second client (the Go proxy, the desktop app) against the same account: two
processes refreshing one refresh token invalidate each other.

## Models

The catalog is live: `GET llm/v2/model_catalog` on every session start, filtered to
`visible` entries. Model ids are the upstream ids — the gateway does no aliasing.

A six-model fallback list is registered at load time and restored whenever a catalog fetch
fails, so the model list never goes empty mid-session.

| | |
| --- | --- |
| Context window | `context_window` from the catalog, else 128K |
| Max output | `max_tokens` from the catalog, else 8K |
| Input | text and images (OpenAI multimodal `content` arrays) |
| Cost | zero — the gateway bills in points, not USD per token |
| Thinking | surfaced from `delta.reasoning_content` as thinking blocks |

## Commands

| Command | What it does |
| --- | --- |
| `/xhx` | provider, origin, auth source, token tail, model count, points balance |
| `/xhx-balance` | `points/v1/balance` |
| `/xhx-checkin` | triggers the daily points grant (`office/v3/setting_info`) |
| `/xhx-models` | lists the registered models |

## Environment

| Variable | Meaning |
| --- | --- |
| `XHX_ACCESS_TOKEN` | use a token directly instead of `/login`; also the fallback when no credential is stored |
| `XHX_ORIGIN` | point the extension at a mirror or a local mock (default `https://xiaohuanxiong.com`) |

`XHX_ACCESS_TOKEN` is enough to start using the provider without the login flow:

```bash
XHX_ACCESS_TOKEN=eyJhbGci… pi --provider xhx --model sn-glm-5-3-flash
```

Grab it from the browser: log in at `xiaohuanxiong.com`, open DevTools → Network, copy the
`Authorization: Bearer eyJ…` value from any request. The desktop client keeps the same pair
in `~/.box-agent/config/auth.json`.

## Endpoints

| Purpose | Request |
| --- | --- |
| Authorize page | `GET {origin}/code/authorize?login_source=desktop&appname=…&state=…` |
| Code exchange | `POST {origin}/api/web/auth/v1/login_with_authorization_code` |
| Token refresh | `POST {origin}/api/web/auth/v1/refresh` |
| Model catalog | `GET {origin}/api/web/llm/v2/model_catalog` |
| Chat | `POST {origin}/api/web/llm/v2/chat/completions` |
| Balance | `GET {origin}/api/web/points/v1/balance` |
| Entitlement | `GET {origin}/api/web/auth/v1/entitlement_info` |
| Daily grant | `GET {origin}/api/web/office/v3/setting_info` |

## Wire compatibility

pi's `openai-completions` implementation auto-detects compatibility from the provider id and
base URL. `xiaohuanxiong.com` matches none of its known hosts, so the detected defaults would
be the strict-OpenAI ones — `store: false`, `role: "developer"`, `reasoning_effort`,
`max_completion_tokens`. The gateway is a proxy in front of several vendors' models and only
guarantees the classic Chat Completions surface, so `src/compat.ts` turns all of those off and
sends `max_tokens` instead.

A single unparseable `data:` frame would make the OpenAI SDK's SSE parser throw and kill an
otherwise healthy answer, so `src/sse.ts` wraps fetch and drops only the frames that do not
parse. One bad frame costs one frame, not the response.

`stream_options: {include_usage: true}` is kept because usage accounting depends on it. If the
gateway rejects that field with a 400, the stream wrapper retries once without it — the
rejection happens before any content event, so the retry cannot duplicate output.

## Development

```bash
npm install
npm run typecheck
npm test          # 47 tests against a mock gateway
npm run build     # esbuild -> dist/index.js
```

`test/mock-upstream.ts` implements the gateway's endpoints with the documented response
shapes: the `{code,message,data}` envelope, the `categories[].models[]` catalog, and
OpenAI-shaped SSE frames carrying `reasoning_content`, tool calls, and a trailing usage chunk.

To drive a real `pi` process against it:

```bash
node test/manual/serve-mock.ts 18080          # prints {origin, token}
XHX_ORIGIN=http://127.0.0.1:18080 XHX_ACCESS_TOKEN=<token> \
  pi -e . -p "hello" --provider xhx --model sn-glm-5-3-flash
```

## Verification

What the test suite and the real runs cover:

- 47 tests against the mock gateway: login (happy path, state mismatch, expired code, HTTP
  error), refresh (rotation, no rotation, rejection), catalog parsing and 401 handling, model
  mapping, streaming (text, `reasoning_content`, usage, tool calls, `stream_options` retry,
  401, abort), account endpoints, provider registration.
- A real `pi` process against the mock gateway: text reply, tool-call round trip (pi executed
  `read` and sent the result back), thinking blocks, and the session-start catalog refresh.
- The live host: `llm/v2/model_catalog` answers 401 without a bearer token, `/code/authorize`
  answers 307, `auth/v1/refresh` answers `code=100002` for a malformed token, and a chat with
  a bogus token surfaces `401 authorization_verify_error`.
- The published tarball: `pi -e npm:pi-provider-xhx --list-models` registers the provider.

Not covered: a successful chat against the live gateway with a real account. That needs
credentials this repository does not have.

## Limitations

- The gateway's "upload a file" entry point (upload to the Raccoon side, then reference it) is
  not implemented; images go inline as `data:` URLs.
- Image input is declared for every catalog model. Models that do not accept images answer
  with an upstream error rather than being hidden from the picker.
- Thinking is read from the stream but not requested: no `reasoning_effort`, `thinking`, or
  `enable_thinking` field is sent, because the gateway's accepted field differs per vendor.
- Upstream model behaviour, quotas, and risk controls can change without notice.

## Troubleshooting

**`401 authorization_verify_error`** — the access token is expired or was invalidated by
another client refreshing the same account. Run `/login xhx` again.

**`/login xhx` says the state does not match** — the callback URL came from an earlier login
attempt. Start the login again and paste the URL from that attempt.

**The model list is the six-model fallback** — the catalog fetch failed. `/xhx` shows the
origin and auth source; a 401 there means the token is dead, a timeout means the network.

**`stream_options` errors** — the extension retries once without the field. If the retry also
fails, the gateway rejected something else; the error text carries the upstream message.

## Credits

The protocol — endpoints, envelope shapes, catalog parsing rules, and the OAuth callback
scheme — was reverse-engineered by
[haoxinyu1/xiaohuanxiong2api](https://github.com/haoxinyu1/xiaohuanxiong2api), a Go proxy for
the same gateway. This extension is an independent TypeScript implementation of that surface
that runs inside pi instead of in front of it.

Not affiliated with SenseTime. Use your own account.
