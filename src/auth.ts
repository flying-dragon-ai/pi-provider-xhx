/**
 * OAuth login and token refresh against the 小浣熊 auth service.
 *
 * Login is a browser OAuth loopback flow:
 *   1. bind a throwaway HTTP server on 127.0.0.1
 *   2. open `{origin}/code/authorize?login_source=desktop&desktop_callback=loopback
 *      &appname=…&state=<64 hex>&redirect=http://127.0.0.1:<port>/auth/callback`
 *   3. the page redirects the browser back to that loopback URL with
 *      `?code=…&state=…` once the user signs in
 *   4. exchange the one-time code at `{auth_base}/login_with_authorization_code`
 *
 * The authorize page validates the loopback pair strictly: the redirect must be
 * `http://127.0.0.1:<port>/auth/callback` with a port in 1024..65535, and the
 * state must be exactly 64 lowercase hex characters. Anything else falls back
 * to the `office-raccoon://auth/callback` scheme, which a browser cannot open.
 *
 * If the browser never comes back (remote shell, blocked loopback), the login
 * falls back to asking for the callback URL, which still works.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import {
	CALLBACK_HOST,
	CALLBACK_PATH,
	CALLBACK_SCHEME,
	CODE_EXPIRED,
	EXPIRY_MARGIN_MS,
	LOOPBACK_PATH,
	authBase,
	authorizeUrl,
	loginTimeoutMs,
	resolveOrigin,
} from "./constants.ts";
import { jwtExpiry, jwtUserId } from "./jwt.ts";

const MAX_CODE_LENGTH = 8192;

export interface XhxCredentials extends OAuthCredentials {
	userId?: string;
	officeIdentity?: string;
	officeOrgName?: string;
	officeOrgRole?: string;
}

interface UpstreamEnvelope {
	code?: number;
	message?: string;
	msg?: string;
	data?: unknown;
}

/** Raised when the browser does not come back in time. */
export class LoginTimeoutError extends Error {
	constructor() {
		super("等待浏览器回调超时");
		this.name = "LoginTimeoutError";
	}
}

/** 32 random bytes as 64 lowercase hex characters — the shape the page requires. */
function randomState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value.trim().replace(/^Bearer\s+/i, "");
	if (typeof value === "number") return String(value);
	return "";
}

async function readEnvelope(response: Response): Promise<{ status: number; body: UpstreamEnvelope; raw: string }> {
	const raw = await response.text();
	let body: UpstreamEnvelope = {};
	try {
		body = asRecord(JSON.parse(raw)) as UpstreamEnvelope;
	} catch {
		body = {};
	}
	return { status: response.status, body, raw };
}

function upstreamMessage(body: UpstreamEnvelope, raw: string): string {
	const message = body.message ?? body.msg;
	if (typeof message === "string" && message !== "") return message;
	const trimmed = raw.trim();
	return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

const SUCCESS_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>登录成功</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;
justify-content:center;height:100vh;margin:0;background:#0f1115;color:#e6e6e6}
main{text-align:center}h1{font-size:20px;font-weight:600;margin:0 0 8px}
p{margin:0;color:#9aa0a6;font-size:14px}
</style></head><body><main><h1>登录成功</h1><p>可以关闭此页面，回到 pi 继续。</p></main></body></html>`;

interface LoopbackServer {
	port: number;
	waitForCode(signal: AbortSignal | undefined, timeoutMs: number): Promise<{ code: string; state: string }>;
	close(): Promise<void>;
}

/** Bind a one-shot HTTP server that receives the OAuth redirect. */
function startLoopbackServer(expectedState: string): Promise<LoopbackServer> {
	return new Promise((resolve, reject) => {
		let settle: ((value: { code: string; state: string }) => void) | undefined;
		const received = new Promise<{ code: string; state: string }>((res) => {
			settle = res;
		});

		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== LOOPBACK_PATH) {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("not found");
				return;
			}
			const code = (url.searchParams.get("code") ?? "").trim();
			const state = (url.searchParams.get("state") ?? "").trim();
			if (code === "" || code.length > MAX_CODE_LENGTH) {
				res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("missing code");
				return;
			}
			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
				res.end("state mismatch");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(SUCCESS_PAGE);
			settle?.({ code, state });
		});

		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo | null;
			if (!address || typeof address === "string") {
				reject(new Error("无法在 127.0.0.1 上启动登录回调服务"));
				return;
			}
			resolve({
				port: address.port,
				waitForCode(signal, timeoutMs) {
					return new Promise((res, rej) => {
						let settled = false;
						let timer: ReturnType<typeof setTimeout> | undefined;
						const cleanup = () => {
							if (timer) clearTimeout(timer);
							signal?.removeEventListener("abort", onAbort);
						};
						const resolveOnce = (value: { code: string; state: string }) => {
							if (settled) return;
							settled = true;
							cleanup();
							res(value);
						};
						const rejectOnce = (error: Error) => {
							if (settled) return;
							settled = true;
							cleanup();
							rej(error);
						};
						function onAbort() {
							rejectOnce(new Error("登录已取消"));
						}
						timer = setTimeout(() => rejectOnce(new LoginTimeoutError()), timeoutMs);
						signal?.addEventListener("abort", onAbort, { once: true });
						void received.then(resolveOnce);
						if (signal?.aborted) onAbort();
					});
				},
				close() {
					return new Promise<void>((done) => {
						server.closeAllConnections?.();
						server.close(() => done());
					});
				},
			});
		});
	});
}

/** Parse `office-raccoon://auth/callback?code=…&state=…`, or a bare code. */
export function parseCallbackInput(input: string): { code: string; state: string } {
	const trimmed = input.trim();
	if (trimmed === "") throw new Error("没有收到回调内容，请重新发起登录");

	if (!trimmed.includes("://")) {
		if (trimmed.length > MAX_CODE_LENGTH) throw new Error("授权码过长，请粘贴完整的回调地址");
		return { code: trimmed, state: "" };
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("回调地址无法解析，请粘贴完整的 office-raccoon://auth/callback?code=… 地址");
	}
	if (
		parsed.protocol !== `${CALLBACK_SCHEME}:` ||
		parsed.host.toLowerCase() !== CALLBACK_HOST ||
		parsed.pathname !== CALLBACK_PATH
	) {
		throw new Error(`回调地址形态无效：需要 ${CALLBACK_SCHEME}://${CALLBACK_HOST}${CALLBACK_PATH}?code=…`);
	}
	const code = (parsed.searchParams.get("code") ?? "").trim();
	const state = (parsed.searchParams.get("state") ?? "").trim();
	if (code === "") throw new Error("回调地址里没有授权码");
	if (code.length > MAX_CODE_LENGTH) throw new Error("授权码过长，请重新发起登录");
	return { code, state };
}

function credentialsFromTokens(access: string, refresh: string, extra: Record<string, unknown>): XhxCredentials {
	const expiry = jwtExpiry(access);
	const credentials: XhxCredentials = {
		access,
		refresh,
		expires: expiry > 0 ? Math.min(Math.max(expiry - EXPIRY_MARGIN_MS, Date.now() + 60_000), expiry) : Date.now() + 3_600_000,
	};
	const userId = jwtUserId(access);
	if (userId !== "") credentials.userId = userId;
	for (const key of ["office_identity", "office_org_name", "office_org_role"] as const) {
		const value = textOf(extra[key]);
		if (value === "") continue;
		if (key === "office_identity") credentials.officeIdentity = value;
		if (key === "office_org_name") credentials.officeOrgName = value;
		if (key === "office_org_role") credentials.officeOrgRole = value;
	}
	return credentials;
}

async function exchangeCode(code: string, signal: AbortSignal | undefined): Promise<OAuthCredentials> {
	const response = await fetch(`${authBase()}/login_with_authorization_code`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ authorization_code: code }),
		...(signal ? { signal } : {}),
	});
	const { status, body, raw } = await readEnvelope(response);

	if (body.code === CODE_EXPIRED) {
		throw new Error("授权码已失效（可能已使用或超时），请重新发起登录");
	}
	const data = asRecord(body.data);
	const access = textOf(data.access_token);
	const refresh = textOf(data.refresh_token);
	if (status < 200 || status >= 300 || access === "" || refresh === "") {
		throw new Error(`换取凭证失败：HTTP ${status} ${upstreamMessage(body, raw)}`);
	}
	return credentialsFromTokens(access, refresh, data);
}

/** Run the interactive login. Returns credentials for pi to persist. */
export async function loginXhx(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	if (callbacks.signal?.aborted) throw new Error("登录已取消");
	const origin = resolveOrigin();
	const state = randomState();

	let server: LoopbackServer | undefined;
	try {
		server = await startLoopbackServer(state);
	} catch {
		server = undefined;
	}

	if (!server) {
		// No loopback: fall back to the custom-scheme flow with a paste.
		const url = authorizeUrl(origin, state, "");
		callbacks.onAuth({
			url,
			instructions: "用微信 / 验证码 / 密码登录。成功后把地址栏里的 office-raccoon://auth/callback?code=… 整条地址复制回来。",
		});
		const answer = await callbacks.onPrompt({
			message: "粘贴 office-raccoon://auth/callback?code=…&state=… 整条地址（或只粘贴 code）：",
			placeholder: "office-raccoon://auth/callback?code=…&state=…",
		});
		const parsed = parseCallbackInput(answer);
		if (parsed.state !== "" && parsed.state !== state) {
			throw new Error("回调 state 与本次登录不匹配，请重新发起登录");
		}
		return exchangeCode(parsed.code, callbacks.signal);
	}

	const redirect = `http://127.0.0.1:${server.port}${LOOPBACK_PATH}`;
	const url = authorizeUrl(origin, state, redirect);

	try {
		callbacks.onAuth({
			url,
			instructions: "用微信 / 验证码 / 密码登录，浏览器会自动跳回本机完成登录。",
		});

		let code: string;
		try {
			const received = await server.waitForCode(callbacks.signal, loginTimeoutMs());
			if (received.state !== state) {
				throw new Error("回调 state 与本次登录不匹配，请重新发起登录");
			}
			code = received.code;
		} catch (error) {
			if (!(error instanceof LoginTimeoutError)) throw error;
			// The browser could not reach the loopback (remote shell, firewall).
			callbacks.onProgress?.("没有等到浏览器回调，改为手动粘贴");
			const answer = await callbacks.onPrompt({
				message: "粘贴 office-raccoon://auth/callback?code=…&state=… 整条地址（或只粘贴 code）：",
				placeholder: "office-raccoon://auth/callback?code=…&state=…",
			});
			const parsed = parseCallbackInput(answer);
			if (parsed.state !== "" && parsed.state !== state) {
				throw new Error("回调 state 与本次登录不匹配，请重新发起登录");
			}
			code = parsed.code;
		}

		callbacks.onProgress?.("正在用授权码换取凭证…");
		return await exchangeCode(code, callbacks.signal);
	} finally {
		await server.close();
	}
}

/** Exchange a refresh token for a new access token. */
export async function refreshXhx(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const previous = credentials as XhxCredentials;
	const response = await fetch(`${authBase()}/refresh`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ refresh_token: previous.refresh }),
		signal,
	});
	const { status, body, raw } = await readEnvelope(response);

	if (status < 200 || status >= 300) {
		throw new Error(`刷新 token 失败：HTTP ${status} ${upstreamMessage(body, raw)}`);
	}
	if (typeof body.code === "number" && body.code !== 0) {
		throw new Error(`刷新 token 失败：code=${body.code} ${upstreamMessage(body, raw)}`);
	}
	const data = asRecord(body.data);
	const access = textOf(data.access_token);
	if (access === "") {
		throw new Error(`刷新 token 失败：上游未返回 access_token（HTTP ${status}）`);
	}
	// The upstream may or may not rotate the refresh token; keep the old one when it does not.
	const rotated = textOf(data.refresh_token);
	const next = credentialsFromTokens(access, rotated === "" ? previous.refresh : rotated, data);
	return { ...previous, ...next };
}

/** pi calls this per request to turn stored credentials into a bearer token. */
export function getApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
