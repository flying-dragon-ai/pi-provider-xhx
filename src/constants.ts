/**
 * Protocol constants for the 小浣熊 (SenseTime Raccoon) web gateway.
 *
 * The values mirror the reverse-engineered surface documented by
 * https://github.com/haoxinyu1/xiaohuanxiong2api — the Go proxy that this
 * extension replaces. Every path below is verified against the live host:
 * `model_catalog` answers 401 without a bearer token, `/code/authorize`
 * answers 307, and `auth/v1/refresh` answers `code=100002` for a malformed
 * token.
 */

export const PROVIDER_ID = "xhx";
export const PROVIDER_NAME = "小浣熊 (Raccoon)";

export const DEFAULT_ORIGIN = "https://xiaohuanxiong.com";

/** Client identity the official desktop app reports on the authorize page. */
export const LOGIN_SOURCE = "desktop";
export const LOGIN_APP_NAME = "办公小浣熊客户端";

/** Custom scheme the authorize page redirects to. Browsers cannot open it. */
export const CALLBACK_SCHEME = "office-raccoon";
export const CALLBACK_HOST = "auth";
export const CALLBACK_PATH = "/callback";

/** Upstream business code for "authorization code already used or expired". */
export const CODE_EXPIRED = 200035;

/** Refresh this long before the JWT `exp` so a request never races expiry. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * The gateway's risk control treats a non-browser user agent as third-party
 * traffic, so requests carry the same agent a browser on this platform sends.
 */
export const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

/** `XHX_ORIGIN` points the extension at a mirror or a local mock. */
export function resolveOrigin(): string {
	const raw = process.env.XHX_ORIGIN?.trim();
	if (!raw) return DEFAULT_ORIGIN;
	return raw.replace(/\/+$/, "");
}

export function llmBase(origin = resolveOrigin()): string {
	return `${origin}/api/web/llm/v2`;
}

/**
 * The v1 LLM gateway. The v2 endpoint is behind a risk control that blocks
 * non-official clients; v1 answers the same OpenAI shape without it.
 */
export function llmBaseV1(origin = resolveOrigin()): string {
	return `${origin}/api/web/llm/v1`;
}

export function authBase(origin = resolveOrigin()): string {
	return `${origin}/api/web/auth/v1`;
}

export function pointsBase(origin = resolveOrigin()): string {
	return `${origin}/api/web/points/v1`;
}

/**
 * Build the authorize URL for the loopback flow.
 *
 * The page validates the pair strictly (`E()` in the authorize chunk):
 * `redirect` must match `^http://127\.0\.0\.1:<port>/auth/callback$` with a
 * port in 1024..65535, `state` must be exactly 64 lowercase hex characters,
 * `login_source` must be `desktop`, and `desktop_callback` must be `loopback`.
 * When all of that holds the page redirects to the loopback URL with
 * `?code=…&state=…` instead of the `office-raccoon://` scheme.
 */
export function authorizeUrl(origin: string, state: string, redirect?: string): string {
	const url = new URL("/code/authorize", origin);
	url.searchParams.set("login_source", LOGIN_SOURCE);
	url.searchParams.set("appname", LOGIN_APP_NAME);
	url.searchParams.set("state", state);
	if (redirect) {
		url.searchParams.set("desktop_callback", "loopback");
		url.searchParams.set("redirect", redirect);
	}
	return url.toString();
}

/** Path the authorize page redirects to on the loopback server. */
export const LOOPBACK_PATH = "/auth/callback";

/** How long to wait for the browser to come back before offering a paste. */
export function loginTimeoutMs(): number {
	const raw = process.env.XHX_LOGIN_TIMEOUT_MS?.trim();
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
}
