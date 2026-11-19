/**
 * OAuth login and token refresh against the 小浣熊 auth service.
 *
 * Flow (identical to the official desktop client):
 *   1. open `{origin}/code/authorize?login_source=desktop&appname=…&state=…`
 *   2. the page redirects to `office-raccoon://auth/callback?code=…&state=…`
 *   3. exchange the one-time code at `{auth_base}/login_with_authorization_code`
 *
 * The redirect target is a custom scheme, so the browser cannot follow it.
 * The user copies the address bar contents back into the prompt.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import {
	CALLBACK_HOST,
	CALLBACK_PATH,
	CALLBACK_SCHEME,
	CODE_EXPIRED,
	EXPIRY_MARGIN_MS,
	authBase,
	authorizeUrl,
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

function randomState(): string {
	const bytes = new Uint8Array(16);
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
		expires: expiry > 0 ? Math.max(expiry - EXPIRY_MARGIN_MS, Date.now() + 60_000) : Date.now() + 3_600_000,
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

/** Run the interactive login. Returns credentials for pi to persist. */
export async function loginXhx(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const origin = resolveOrigin();
	const state = randomState();
	const url = authorizeUrl(origin, state);

	callbacks.onAuth({
		url,
		instructions:
			"用微信 / 验证码 / 密码登录。成功后页面会跳转到 office-raccoon://auth/callback?code=…&state=…，" +
			"浏览器打不开这个协议是正常的：把地址栏里的整条地址复制回来即可。",
	});

	const answer = await callbacks.onPrompt({
		message: "粘贴 office-raccoon://auth/callback?code=…&state=… 整条地址（或只粘贴 code）：",
		placeholder: "office-raccoon://auth/callback?code=…&state=…",
	});

	const parsed = parseCallbackInput(answer);
	if (parsed.state !== "" && parsed.state !== state) {
		throw new Error("回调 state 与本次登录不匹配，请重新发起登录");
	}

	callbacks.onProgress?.("正在用授权码换取凭证…");

	const response = await fetch(`${authBase(origin)}/login_with_authorization_code`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ authorization_code: parsed.code }),
		...(callbacks.signal ? { signal: callbacks.signal } : {}),
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
