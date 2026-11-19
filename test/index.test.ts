import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claimDailyGrant, fetchBalance, fetchEntitlement } from "../src/api.ts";
import xhxExtension from "../src/index.ts";
import { FALLBACK_MODELS } from "../src/models.ts";
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

describe("account endpoints", () => {
	it("parses the balance envelope, including numeric strings", async () => {
		const balance = await fetchBalance(mock.validAccessToken());
		expect(balance).toEqual({ available: 1234, daily: 300, monthly: 9000, reward: 0 });
	});

	it("triggers the daily grant with the desktop client headers", async () => {
		const grant = await claimDailyGrant(mock.validAccessToken());
		expect(grant.popups).toHaveLength(1);
		const request = mock.requests.find((r) => r.path.endsWith("/setting_info"));
		expect(request?.headers["x-client-platform"]).toBe("desktop-windows");
	});

	it("rejects an unauthorized balance request", async () => {
		await expect(fetchBalance("stale")).rejects.toThrow(/HTTP 401/);
	});

	it("returns the raw entitlement node", async () => {
		await expect(fetchEntitlement(mock.validAccessToken())).resolves.toEqual({ plan: "free", seats: 1 });
	});
});

describe("extension factory", () => {
	function load() {
		const providers = new Map<string, Record<string, unknown>>();
		const commands: string[] = [];
		const events: string[] = [];
		const pi = {
			registerProvider: (name: string, config: Record<string, unknown>) => {
				providers.set(name, config);
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			on: (event: string) => {
				events.push(event);
				return () => {};
			},
		} as unknown as ExtensionAPI;
		xhxExtension(pi);
		return { providers, commands, events };
	}

	it("registers the xhx provider with oauth, catalog refresh and streaming", () => {
		const { providers } = load();
		const config = providers.get("xhx");
		expect(config).toBeDefined();
		expect(config?.api).toBe("openai-completions");
		expect(config?.baseUrl).toBe(`${mock.origin}/api/web/llm/v2`);
		expect(config?.apiKey).toBe("$XHX_ACCESS_TOKEN");
		expect(config?.models).toEqual(FALLBACK_MODELS);
		const oauth = config?.oauth as Record<string, unknown>;
		expect(typeof oauth.login).toBe("function");
		expect(typeof oauth.refreshToken).toBe("function");
		expect(typeof oauth.getApiKey).toBe("function");
		expect(typeof config?.refreshModels).toBe("function");
		expect(typeof config?.streamSimple).toBe("function");
	});

	it("registers the account commands", () => {
		const { commands } = load();
		expect(commands).toEqual(["xhx", "xhx-balance", "xhx-checkin", "xhx-models"]);
	});

	it("asks for a network catalog refresh on session start", () => {
		const { events } = load();
		expect(events).toEqual(["session_start"]);
	});

	it("returns the fallback catalog when no credential is available", async () => {
		const { providers } = load();
		const refresh = providers.get("xhx")?.refreshModels as (context: unknown) => Promise<unknown>;
		const models = await refresh({
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => true,
		});
		expect(models).toEqual(FALLBACK_MODELS);
	});

	it("replaces the fallback with the live catalog", async () => {
		const { providers } = load();
		const refresh = providers.get("xhx")?.refreshModels as (context: unknown) => Promise<unknown>;
		const models = (await refresh({
			credential: { type: "oauth", access: mock.validAccessToken(), refresh: "rt", expires: 0 },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => true,
		})) as { id: string }[];
		expect(models.map((model) => model.id)).toEqual(["sn-glm-5-3-flash", "sn-kimi-k3"]);
	});

	it("keeps the fallback when the catalog fetch fails", async () => {
		const { providers } = load();
		const refresh = providers.get("xhx")?.refreshModels as (context: unknown) => Promise<unknown>;
		const models = await refresh({
			credential: { type: "oauth", access: "stale-token", refresh: "rt", expires: 0 },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => true,
		});
		expect(models).toEqual(FALLBACK_MODELS);
	});
});
