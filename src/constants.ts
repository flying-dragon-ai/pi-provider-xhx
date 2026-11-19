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

export const USER_AGENT = "pi-provider-xhx/0.1.0";

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

export function authBase(origin = resolveOrigin()): string {
	return `${origin}/api/web/auth/v1`;
}

export function pointsBase(origin = resolveOrigin()): string {
	return `${origin}/api/web/points/v1`;
}

export function authorizeUrl(origin: string, state: string): string {
	const url = new URL("/code/authorize", origin);
	url.searchParams.set("login_source", LOGIN_SOURCE);
	url.searchParams.set("appname", LOGIN_APP_NAME);
	url.searchParams.set("state", state);
	return url.toString();
}
