import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginXhx, parseCallbackInput, refreshXhx } from "../src/auth.ts";
import { startMockUpstream, type MockUpstream } from "./mock-upstream.ts";

let mock: MockUpstream;

beforeEach(async () => {
	mock = await startMockUpstream();
	process.env.XHX_ORIGIN = mock.origin;
});

afterEach(async () => {
	delete process.env.XHX_ORIGIN;
	await mock.close();
});

function callbacks(answer: string, seen: { url?: string } = {}) {
	let issuedState = "";
	return {
		onAuth: (info: { url: string }) => {
			seen.url = info.url;
			issuedState = new URL(info.url).searchParams.get("state") ?? "";
		},
		onDeviceCode: () => {},
		onPrompt: async () => answer.replace("{state}", issuedState),
		onSelect: async () => undefined,
	};
}

describe("parseCallbackInput", () => {
	it("reads code and state from a callback URL", () => {
		expect(parseCallbackInput("office-raccoon://auth/callback?code=abc&state=def")).toEqual({
			code: "abc",
			state: "def",
		});
	});

	it("accepts a bare authorization code", () => {
		expect(parseCallbackInput("  abc123  ")).toEqual({ code: "abc123", state: "" });
	});

	it("rejects a foreign scheme", () => {
		expect(() => parseCallbackInput("https://auth/callback?code=abc")).toThrow(/形态无效/);
	});

	it("rejects a look-alike host", () => {
		expect(() => parseCallbackInput("office-raccoon://auth.evil.com/callback?code=abc")).toThrow(/形态无效/);
	});

	it("rejects a callback without a code", () => {
		expect(() => parseCallbackInput("office-raccoon://auth/callback?state=def")).toThrow(/没有授权码/);
	});

	it("rejects empty input", () => {
		expect(() => parseCallbackInput("   ")).toThrow(/没有收到回调内容/);
	});
});

describe("loginXhx", () => {
	it("opens the authorize page with the desktop client identity", async () => {
		const seen: { url?: string } = {};
		await loginXhx(callbacks("office-raccoon://auth/callback?code=good&state={state}", seen) as never);
		const url = new URL(seen.url ?? "");
		expect(url.origin).toBe(mock.origin);
		expect(url.pathname).toBe("/code/authorize");
		expect(url.searchParams.get("login_source")).toBe("desktop");
		expect(url.searchParams.get("appname")).toBe("办公小浣熊客户端");
		expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
	});

	it("exchanges the code and derives expiry from the JWT", async () => {
		const credentials = await loginXhx(
			callbacks("office-raccoon://auth/callback?code=good&state={state}") as never,
		);
		expect(credentials.access).toBe(mock.validAccessToken());
		expect(credentials.refresh).toBe("rt-initial");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 3600_000);
		expect(credentials.userId).toBe("7591340");
		expect(credentials.officeOrgName).toBe("Acme");

		const exchange = mock.requests.find((r) => r.path.endsWith("/login_with_authorization_code"));
		expect(exchange?.body).toBe(JSON.stringify({ authorization_code: "good" }));
	});

	it("rejects a callback whose state does not match the issued one", async () => {
		let issuedState = "";
		const mismatched = {
			onAuth: (info: { url: string }) => {
				issuedState = new URL(info.url).searchParams.get("state") ?? "";
			},
			onDeviceCode: () => {},
			onPrompt: async () => "office-raccoon://auth/callback?code=good&state=wrong",
			onSelect: async () => undefined,
		};
		await expect(loginXhx(mismatched as never)).rejects.toThrow(/state 与本次登录不匹配/);
		expect(issuedState).toMatch(/^[0-9a-f]{32}$/);
	});

	it("reports an expired authorization code", async () => {
		await expect(loginXhx(callbacks("expired-code") as never)).rejects.toThrow(/授权码已失效/);
	});

	it("surfaces the upstream HTTP status for a rejected code", async () => {
		await expect(loginXhx(callbacks("bad-code") as never)).rejects.toThrow(/HTTP 400/);
	});
});

describe("refreshXhx", () => {
	it("keeps the old refresh token when the upstream does not rotate it", async () => {
		const credentials = await loginXhx(callbacks("good") as never);
		const refreshed = await refreshXhx(credentials, new AbortController().signal);
		expect(refreshed.access).toBe(mock.validAccessToken());
		expect(refreshed.refresh).toBe("rt-initial");
		expect(refreshed.expires).toBeGreaterThan(Date.now());
	});

	it("adopts a rotated refresh token", async () => {
		await mock.close();
		mock = await startMockUpstream({ rotateRefreshToken: true });
		process.env.XHX_ORIGIN = mock.origin;

		const credentials = await loginXhx(callbacks("good") as never);
		const refreshed = await refreshXhx(credentials, new AbortController().signal);
		expect(refreshed.refresh).toBe("rt-rotated-1");
	});

	it("throws when the refresh token is rejected", async () => {
		await expect(
			refreshXhx({ access: "a", refresh: "rt-dead", expires: 0 }, new AbortController().signal),
		).rejects.toThrow(/刷新 token 失败/);
	});
});
