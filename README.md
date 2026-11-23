<div align="center">

# pi-provider-xhx

**小浣熊 (SenseTime Raccoon) as a first-class [pi](https://pi.dev) provider**

OAuth login · live model catalog · OpenAI-compatible streaming

[![npm](https://img.shields.io/npm/v/pi-provider-xhx?color=cb3837&label=npm)](https://www.npmjs.com/package/pi-provider-xhx)
[![pi](https://img.shields.io/badge/pi-extension-blueviolet)](https://pi.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-58%20passing-brightgreen)](#verification)

</div>

---

A pi extension that connects pi to **小浣熊** — the `xiaohuanxiong.com` web/desktop gateway — as a first-class provider.

**No local proxy process.** The extension speaks the gateway's OpenAI-compatible Chat Completions surface directly, holds the OAuth credentials, refreshes them through pi's auth layer, and streams through pi's own `openai-completions` implementation.

## Highlights

| | |
| --- | --- |
| 🔐 **One-shot OAuth** | Browser loopback login — sign in once, nothing to copy |
| 📡 **Live catalog** | Models fetched from the gateway on every session start, with a built-in fallback list |
| 🧠 **Thinking levels** | pi's thinking levels mapped onto the gateway's `raccoon_thinking` levels |
| 🖼️ **Multimodal** | Text + image input via OpenAI `content` arrays |
| 💰 **Zero USD cost** | The gateway bills in points, not per-token USD |
| 🛡️ **Resilient SSE** | Malformed frames are dropped, not fatal; `stream_options` 400s retried once |

## Quick start

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

## Contents

- [Login](#login)
  - [Token lifetime](#token-lifetime)
- [Models](#models)
  - [Thinking levels](#thinking-levels)
- [Commands](#commands)
- [Environment](#environment)
- [Endpoints](#endpoints)
- [Wire compatibility](#wire-compatibility)
- [Development](#development)
- [Verification](#verification)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

---

## Login

`/login xhx` runs a browser OAuth loopback flow. The extension binds a throwaway HTTP server on `127.0.0.1`, opens the official authorize page, and the page redirects the browser straight back to that local server once you sign in:

```text
https://xiaohuanxiong.com/code/authorize
  ?login_source=desktop
  &desktop_callback=loopback
  &appname=办公小浣熊客户端
  &state=<64 hex>
  &redirect=http://127.0.0.1:<port>/auth/callback
```

Sign in with WeChat, SMS, or password. The browser lands on a 「登录成功」 page, the extension verifies `state`, exchanges the one-time code at `auth/v1/login_with_authorization_code`, and stores the credentials in `~/.pi/agent/auth.json`. Nothing to copy.

The authorize page validates the loopback pair strictly — the redirect must be `http://127.0.0.1:<port>/auth/callback` with a port in 1024..65535, and `state` must be exactly 64 lowercase hex characters. Anything else falls back to the `office-raccoon://auth/callback` scheme, which a browser cannot open.

> 💡 If the browser cannot reach the loopback (remote shell, firewall), the login waits `XHX_LOGIN_TIMEOUT_MS` (default 5 minutes) and then asks for the callback URL instead. Pasting only the `code` also works; the `state` check is skipped in that case.

### Token lifetime

The access token is a JWT. The extension reads `exp` and schedules a refresh five minutes before it, so a request never races expiry. The refresh token is rotated when the upstream rotates it and kept when it does not.

> ⚠️ Do not run a second client (the Go proxy, the desktop app) against the same account: two processes refreshing one refresh token invalidate each other.

---

## Models

The catalog is live: `GET llm/v2/model_catalog` on every session start, filtered to `visible` entries. Model ids are the upstream ids — the gateway does no aliasing.

A seven-model fallback list (the current live catalog) is registered at load time and restored whenever a catalog fetch fails, so the model list never goes empty mid-session.

| | |
| --- | --- |
| Context window | `context_window` from the catalog, else 128K |
| Max output | `max_tokens` from the catalog, else 8K |
| Input | text and images (OpenAI multimodal `content` arrays) |
| Cost | zero — the gateway bills in points, not USD per token |
| Thinking | `raccoon_thinking`, mapped from pi's thinking level (see below) |

### Thinking levels

The catalog describes each model's thinking control under `params.raccoon_thinking`: the levels it accepts (`level_1` … `level_5`, sometimes a subset) and whether `off` is allowed. The extension maps pi's thinking levels onto those values and sends the result as the `raccoon_thinking` request field:

| pi level | three-level model | five-level model |
| --- | :---: | :---: |
| off | `level_1` (or `off` when the model allows it) | `level_1` (or `off`) |
| minimal | `level_1` | `level_1` |
| low | `level_1` | `level_2` |
| medium | `level_3` | `level_3` |
| high / xhigh / max | `level_5` | `level_5` |

Pick a level with `/thinking`, `--thinking <level>`, or the model's thinking selector. The gateway always reasons for models that cannot disable it, so `off` means "the lowest level" there. Reasoning arrives as `delta.reasoning_content` and is rendered as thinking blocks.

---

## Commands

| Command | What it does |
| --- | --- |
| `/xhx` | provider, origin, auth source, token tail, model count, points balance |
| `/xhx-balance` | `points/v1/balance` |
| `/xhx-checkin` | triggers the daily points grant (`office/v3/setting_info`) |
| `/xhx-models` | lists the registered models |

---

## Environment

| Variable | Meaning |
| --- | --- |
| `XHX_ACCESS_TOKEN` | use a token directly instead of `/login`; also the fallback when no credential is stored |
| `XHX_ORIGIN` | point the extension at a mirror or a local mock (default `https://xiaohuanxiong.com`) |
| `XHX_LOGIN_TIMEOUT_MS` | how long the loopback login waits for the browser before offering a paste (default 300000) |
| `XHX_MAX_TOKENS` | output reservation sent with each request (default 16384; the catalog allows 100000) |
| `XHX_MIN_INTERVAL_MS` | minimum spacing between requests (default 400; `0` disables) |
| `XHX_ORG_CODE` | value for the `X-Org-Code` header the official client sends (default empty) |

`XHX_ACCESS_TOKEN` is enough to start using the provider without the login flow:

```bash
XHX_ACCESS_TOKEN=eyJhbGci… pi --provider xhx --model sn-glm-5-3-flash
```

Grab it from the browser: log in at `xiaohuanxiong.com`, open DevTools → Network, copy the `Authorization: Bearer eyJ…` value from any request. The desktop client keeps the same pair in `~/.box-agent/config/auth.json`.

---

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

---

## Wire compatibility

pi's `openai-completions` implementation auto-detects compatibility from the provider id and base URL. `xiaohuanxiong.com` matches none of its known hosts, so the detected defaults would be the strict-OpenAI ones — `store: false`, `role: "developer"`, `reasoning_effort`, `max_completion_tokens`. The gateway is a proxy in front of several vendors' models and only guarantees the classic Chat Completions surface, so `src/compat.ts` turns all of those off and sends `max_tokens` instead.

A single unparseable `data:` frame would make the OpenAI SDK's SSE parser throw and kill an otherwise healthy answer, so `src/sse.ts` wraps fetch and drops only the frames that do not parse. One bad frame costs one frame, not the response.

`stream_options: {include_usage: true}` is kept because usage accounting depends on it. If the gateway rejects that field with a 400, the stream wrapper retries once without it — the rejection happens before any content event, so the retry cannot duplicate output.

---

## Development

```bash
npm install
npm run typecheck
npm test          # 58 tests against a mock gateway
npm run build     # esbuild -> dist/index.js
```

`test/mock-upstream.ts` implements the gateway's endpoints with the documented response shapes: the `{code,message,data}` envelope, the `categories[].models[]` catalog, and OpenAI-shaped SSE frames carrying `reasoning_content`, tool calls, and a trailing usage chunk.

To drive a real `pi` process against it:

```bash
node test/manual/serve-mock.ts 18080          # prints {origin, token}
XHX_ORIGIN=http://127.0.0.1:18080 XHX_ACCESS_TOKEN=<token> \
  pi -e . -p "hello" --provider xhx --model sn-glm-5-3-flash
```

---

## Verification

What the test suite and the real runs cover:

- **58 tests against the mock gateway** — login (loopback happy path, state mismatch, expired code, HTTP error, paste fallback), refresh (rotation, no rotation, rejection), catalog parsing and 401 handling, model mapping, streaming (text, `reasoning_content`, usage, tool calls, `stream_options` retry, 401, abort, empty response, malformed frame, split surrogate pair, mid-stream disconnect, image input), account endpoints, provider registration.
- **A real `pi` process against the mock gateway** — text reply, tool-call round trip (pi executed `read` and sent the result back), thinking blocks, and the session-start catalog refresh.
- **The live gateway with a real account** — `/login xhx` completed through the loopback redirect and stored an IAM JWT; a chat answered `1+1等于2。`; a tool-call round trip read a file and returned its contents; `/xhx-models` listed the seven live catalog models with their upstream descriptions; `points/v1/balance` returned the account's points.
- **The live host without credentials** — `llm/v2/model_catalog` answers 401, `/code/authorize` answers 307, `auth/v1/refresh` answers `code=100002` for a malformed token, and a chat with a bogus token surfaces `401 authorization_verify_error`.
- **The published tarball** — `pi -e npm:pi-provider-xhx --list-models` registers the provider.

---

## Limitations

- The gateway's "upload a file" entry point (upload to the Raccoon side, then reference it) is not implemented; images go inline as `data:` URLs.
- Image input is declared for every catalog model. Models that do not accept images answer with an upstream error rather than being hidden from the picker.
- Thinking is read from the stream but not requested: no `reasoning_effort`, `thinking`, or `enable_thinking` field is sent, because the gateway's accepted field differs per vendor.
- Upstream model behaviour, quotas, and risk controls can change without notice.

---

## Troubleshooting

<details>
<summary><b>401 authorization_verify_error</b></summary>

The access token is expired or was invalidated by another client refreshing the same account. Run `/login xhx` again.

</details>

<details>
<summary><b>/login xhx says the state does not match</b></summary>

The callback URL came from an earlier login attempt. Start the login again and paste the URL from that attempt.

</details>

<details>
<summary><b>The model list is the six-model fallback</b></summary>

The catalog fetch failed. `/xhx` shows the origin and auth source; a 401 there means the token is dead, a timeout means the network.

</details>

<details>
<summary><b>stream_options errors</b></summary>

The extension retries once without the field. If the retry also fails, the gateway rejected something else; the error text carries the upstream message.

</details>

<details>
<summary><b>429 with code 200108</b></summary>

The gateway has flagged the account for abnormal usage and blocked model calls. It does not clear on its own in a reasonable time. Open the 小浣熊 app, click the avatar in the bottom-left, choose 「问题反馈」 and ask them to lift the restriction, or sign in with another account.

</details>

The extension sends what the official client sends: the same header set (`Authorization`, `Content-Type`, `X-Org-Code`, `X-Raccoon-Language`), a browser user agent, `verbose: true`, a 16K output reservation instead of the catalog's 100K, and at least 400 ms between requests. What it cannot hide is the workload: a long agent session sends far more tokens than a human chatting in the web app, and pi's system prompt is not the office assistant's. A consumer account can still be flagged.

---

## Credits

The protocol — endpoints, envelope shapes, catalog parsing rules, and the OAuth callback scheme — was reverse-engineered by [haoxinyu1/xiaohuanxiong2api](https://github.com/haoxinyu1/xiaohuanxiong2api), a Go proxy for the same gateway. This extension is an independent TypeScript implementation of that surface that runs inside pi instead of in front of it.

> Not affiliated with SenseTime. Use your own account.
