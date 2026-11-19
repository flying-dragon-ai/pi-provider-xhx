import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { fetchCatalog, parseCatalog, toModelConfigs } from "../src/catalog.ts";
import { XHX_COMPAT } from "../src/compat.ts";
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

describe("parseCatalog", () => {
	it("flattens categories, drops duplicates and nameless entries", () => {
		const entries = parseCatalog({
			code: 0,
			data: {
				categories: [
					{
						models: [
							{ name: "a", display_description: "A" },
							{ name: "a", display_description: "A again" },
							{ name: "", description: "nameless" },
							{ name: "b", params: { context_window: 1000, max_tokens: 100 } },
						],
					},
					{ models: [{ name: "c", visible: false }] },
				],
			},
		});
		expect(entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
		expect(entries[0]?.name).toBe("A");
		expect(entries[1]?.contextWindow).toBe(1000);
		expect(entries[1]?.maxTokens).toBe(100);
		expect(entries[2]?.visible).toBe(false);
	});

	it("accepts a payload whose root is the categories object", () => {
		const entries = parseCatalog({ categories: [{ models: [{ name: "x" }] }] });
		expect(entries).toHaveLength(1);
		expect(entries[0]?.id).toBe("x");
	});

	it("prefers top-level limits over params", () => {
		const entries = parseCatalog({
			categories: [{ models: [{ name: "x", context_window: 5, params: { context_window: 9 } }] }],
		});
		expect(entries[0]?.contextWindow).toBe(5);
	});

	it("returns an empty list for a payload without categories", () => {
		expect(parseCatalog({ code: 0, data: {} })).toEqual([]);
		expect(parseCatalog(null)).toEqual([]);
	});
});

describe("fetchCatalog", () => {
	it("sends the bearer token and returns entries", async () => {
		const entries = await fetchCatalog(mock.validAccessToken());
		expect(entries.map((entry) => entry.id)).toEqual(["sn-glm-5-3-flash", "sn-kimi-k3", "raccoon-internal"]);
		const request = mock.requests.find((r) => r.path.endsWith("/model_catalog"));
		expect(request?.headers.authorization).toBe(`Bearer ${mock.validAccessToken()}`);
	});

	it("throws on 401", async () => {
		await expect(fetchCatalog("not-a-token")).rejects.toThrow(/HTTP 401/);
	});
});

describe("toModelConfigs", () => {
	it("drops invisible models and applies the gateway compat flags", async () => {
		const configs = toModelConfigs(await fetchCatalog(mock.validAccessToken()));
		expect(configs.map((config) => config.id)).toEqual(["sn-glm-5-3-flash", "sn-kimi-k3"]);
		const first = configs[0] as unknown as Record<string, unknown>;
		expect(first.contextWindow).toBe(131072);
		expect(first.maxTokens).toBe(8192);
		expect(first.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(first.compat).toEqual(XHX_COMPAT);
		expect(first.input).toEqual(["text", "image"]);
	});

	it("falls back to defaults when the catalog omits limits", () => {
		const [config] = toModelConfigs([
			{ id: "x", name: "X", description: "", tags: [], visible: true },
		]) as unknown as { contextWindow?: number; maxTokens?: number }[];
		expect(config?.contextWindow).toBe(128_000);
		expect(config?.maxTokens).toBe(8_192);
	});
});

describe("model shape", () => {
	it("is accepted by pi's Model type", () => {
		const model: Model<"openai-completions"> = {
			id: "sn-glm-5-3-flash",
			name: "GLM-5.3 Flash",
			provider: "xhx",
			api: "openai-completions",
			baseUrl: `${mock.origin}/api/web/llm/v2`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 8192,
		};
		expect(normalizeContext({ messages: [] }).messages).toEqual([]);
		expect(model.id).toBe("sn-glm-5-3-flash");
	});
});
