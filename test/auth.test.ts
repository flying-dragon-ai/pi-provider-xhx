import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginXhx, parseCallbackInput, refreshXhx } from "../src/auth.ts";
import { jwtExpiry } from "../src/jwt.ts";
import { startMockUpstream, type MockUpstream } from "./mock-upstream.ts";

let mock: MockUpstream;

beforeEach(async () => {
	mock = await startMockUpstream();
	process.env.XHX_ORIGIN = mock.origin;
});

afterEach(async () => {
	delete process.env.XHX_ORIGIN;
	delete process.env.XHX_LOGIN_TIMEOUT_MS;
	await mock.close();
});

interface Seen {
	url?: string;
	prompts: number;
}

function callbacks(seen: Seen, answer = ""): Record<string, unknown> {
	return {
		onAuth: (info: { url: string }) => {
			seen.url = info.url;
		},
		onDeviceCode: () => {},
		onPrompt: async () => {
			seen.prompts += 1;
			return answer;
		},
		onSelect: async () => undefined,
	};
}

async function waitForAuthorizeUrl(seen: Seen): Promise<URL> {
	for (let i = 0; i < 300; i += 1) {
		if (seen.url) return new URL(seen.url);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("onAuth was never called");
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

describe("loginXhx loopback flow", () => {
	it("asks the authorize page for a loopback redirect with a 64-hex state", async () => {
		const seen: Seen = { prompts: 0 };
		const promise = loginXhx(callbacks(seen) as never);
		const url = await waitForAuthorizeUrl(seen);

		expect(url.origin).toBe(mock.origin);
		expect(url.pathname).toBe("/code/authorize");
		expect(url.searchParams.get("login_source")).toBe("desktop");
		expect(url.searchParams.get("desktop_callback")).toBe("loopback");
		expect(url.searchParams.get("appname")).toBe("办公小浣熊客户端");
		expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
		expect(url.searchParams.get("redirect")).toMatch(/^http:\/\/127\.0\.0\.1:\d{4,5}\/auth\/callback$/);

		// Finish the flow so the server closes.
		const redirect = url.searchParams.get("redirect") ?? "";
		const state = url.searchParams.get("state") ?? "";
		await fetch(`${redirect}?code=good&state=${state}`);
		await promise;
	});

	it("completes the login when the browser hits the loopback URL", async () => {
		const seen: Seen = { prompts: 0 };
		const promise = loginXhx(callbacks(seen) as never);
		const url = await waitForAuthorizeUrl(seen);

		const redirect = url.searchParams.get("redirect") ?? "";
		const state = url.searchParams.get("state") ?? "";
		const response = await fetch(`${redirect}?code=good&state=${state}`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("登录成功");

		const credentials = await promise;
		expect(credentials.access).toBe(mock.validAccessToken());
		expect(credentials.refresh).toBe("rt-initial");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(credentials.userId).toBe("7591340");
		expect(credentials.officeOrgName).toBe("Acme");
		// No paste prompt was needed.
		expect(seen.prompts).toBe(0);

		const exchange = mock.requests.find((r) => r.path.endsWith("/login_with_authorization_code"));
		expect(exchange?.body).toBe(JSON.stringify({ authorization_code: "good" }));
	});

	it("ignores a foreign state and waits for the real callback", async () => {
		const seen: Seen = { prompts: 0 };
		const promise = loginXhx(callbacks(seen) as never);
		const settled = promise.then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		const url = await waitForAuthorizeUrl(seen);

		const redirect = url.searchParams.get("redirect") ?? "";
		const state = url.searchParams.get("state") ?? "";
		const rejected = await fetch(`${redirect}?code=foreign&state=${"0".repeat(64)}`);
		expect(rejected.status).toBe(400);
		await fetch(`${redirect}?code=good&state=${state}`);

		const result = await settled;
		expect(result).toHaveProperty("value.access", mock.validAccessToken());
		expect(seen.prompts).toBe(0);
	});

	it("reports an expired authorization code", async () => {
		const seen: Seen = { prompts: 0 };
		const promise = loginXhx(callbacks(seen) as never);
		const url = await waitForAuthorizeUrl(seen);

		const redirect = url.searchParams.get("redirect") ?? "";
		const state = url.searchParams.get("state") ?? "";
		const expectation = expect(promise).rejects.toThrow(/授权码已失效/);
		await fetch(`${redirect}?code=expired-code&state=${state}`);
		await expectation;
	});

	it("surfaces the upstream HTTP status for a rejected code", async () => {
		const seen: Seen = { prompts: 0 };
		const promise = loginXhx(callbacks(seen) as never);
		const url = await waitForAuthorizeUrl(seen);

		const redirect = url.searchParams.get("redirect") ?? "";
		const state = url.searchParams.get("state") ?? "";
		const expectation = expect(promise).rejects.toThrow(/HTTP 400/);
		await fetch(`${redirect}?code=bad-code&state=${state}`);
		await expectation;
	});

	it("falls back to a paste when the browser never comes back", async () => {
		process.env.XHX_LOGIN_TIMEOUT_MS = "150";
		const seen: Seen = { prompts: 0 };
		const credentials = await loginXhx(callbacks(seen, "good") as never);
		expect(seen.prompts).toBe(1);
		expect(credentials.access).toBe(mock.validAccessToken());
	});
	it("honors a signal that is already aborted", async () => {
		process.env.XHX_LOGIN_TIMEOUT_MS = "30";
		const controller = new AbortController();
		controller.abort();
		const seen: Seen = { prompts: 0 };
		const promise = loginXhx({ ...callbacks(seen, "good"), signal: controller.signal } as never);
		await expect(promise).rejects.toThrow(/登录已取消/);
		expect(seen.prompts).toBe(0);
	});

	it("never schedules credential use beyond a short-lived JWT expiry", async () => {
		await mock.close();
		mock = await startMockUpstream({ tokenTtlSeconds: 30 });
		process.env.XHX_ORIGIN = mock.origin;
		const seen: Seen = { prompts: 0 };
		const promise = loginXhx(callbacks(seen) as never);
		const url = await waitForAuthorizeUrl(seen);
		const redirect = url.searchParams.get("redirect") ?? "";
		const state = url.searchParams.get("state") ?? "";
		await fetch(`${redirect}?code=good&state=${state}`);
		const credentials = await promise;
		expect(credentials.expires).toBeLessThanOrEqual(jwtExpiry(credentials.access));
	});
});

describe("refreshXhx", () => {
	it("keeps the old refresh token when the upstream does not rotate it", async () => {
		const seen: Seen = { prompts: 0 };
		const promise = loginXhx(callbacks(seen) as never);
		const url = await waitForAuthorizeUrl(seen);
		const redirect = url.searchParams.get("redirect") ?? "";
		const state = url.searchParams.get("state") ?? "";
		await fetch(`${redirect}?code=good&state=${state}`);
		const credentials = await promise;

		const refreshed = await refreshXhx(credentials, new AbortController().signal);
		expect(refreshed.access).toBe(mock.validAccessToken());
		expect(refreshed.refresh).toBe("rt-initial");
		expect(refreshed.expires).toBeGreaterThan(Date.now());
	});

	it("adopts a rotated refresh token", async () => {
		await mock.close();
		mock = await startMockUpstream({ rotateRefreshToken: true });
		process.env.XHX_ORIGIN = mock.origin;

		const seen: Seen = { prompts: 0 };
		const promise = loginXhx(callbacks(seen) as never);
		const url = await waitForAuthorizeUrl(seen);
		const redirect = url.searchParams.get("redirect") ?? "";
		const state = url.searchParams.get("state") ?? "";
		await fetch(`${redirect}?code=good&state=${state}`);
		const credentials = await promise;

		const refreshed = await refreshXhx(credentials, new AbortController().signal);
		expect(refreshed.refresh).toBe("rt-rotated-1");
	});

	it("throws when the refresh token is rejected", async () => {
		await expect(
			refreshXhx({ access: "a", refresh: "rt-dead", expires: 0 }, new AbortController().signal),
		).rejects.toThrow(/刷新 token 失败/);
	});
});
