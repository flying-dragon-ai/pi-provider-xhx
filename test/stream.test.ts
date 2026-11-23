import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { XHX_COMPAT } from "../src/compat.ts";
import { isStreamOptionsRejection, streamXhx } from "../src/stream.ts";
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

function model(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
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
		...overrides,
	};
}

const userContext = normalizeContext({ messages: [{ role: "user", content: "你好", timestamp: Date.now() }] });

async function collect(stream: AsyncIterable<{ type: string }>): Promise<{ types: string[]; final?: AssistantMessage }> {
	const types: string[] = [];
	let final: AssistantMessage | undefined;
	for await (const event of stream) {
		types.push(event.type);
		if (event.type === "done") final = (event as unknown as { message: AssistantMessage }).message;
		if (event.type === "error") final = (event as unknown as { error: AssistantMessage }).error;
	}
	return { types, final };
}

describe("isStreamOptionsRejection", () => {
	it("matches a 400 that names stream_options", () => {
		expect(isStreamOptionsRejection("400 invalid request: unknown field `stream_options`")).toBe(true);
	});

	it("ignores unrelated failures", () => {
		expect(isStreamOptionsRejection("401 unauthorized")).toBe(false);
		expect(isStreamOptionsRejection("400 model not found")).toBe(false);
		expect(isStreamOptionsRejection(undefined)).toBe(false);
	});
});

describe("streamXhx", () => {
	it("streams text, thinking and usage", async () => {
		const { types, final } = await collect(streamXhx(model(), userContext, { apiKey: mock.validAccessToken() }));
		expect(types[0]).toBe("start");
		expect(types.at(-1)).toBe("done");
		expect(final?.stopReason).toBe("stop");
		expect(final?.content).toEqual([
			{ type: "thinking", thinking: "先想一想", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "你好，世界" },
		]);
		expect(final?.usage.input).toBe(10);
		expect(final?.usage.output).toBe(5);
		expect(final?.usage.totalTokens).toBe(15);
	});

	it("sends the gateway-compatible request body", async () => {
		await collect(streamXhx(model(), userContext, { apiKey: mock.validAccessToken(), maxTokens: 256 }));
		const request = mock.requests.find((r) => r.path.endsWith("/chat/completions"));
		const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
		expect(body.model).toBe("sn-glm-5-3-flash");
		expect(body.stream).toBe(true);
		expect(body.max_tokens).toBe(256);
		expect(body.verbose).toBe(true);
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.store).toBeUndefined();
		expect(body.stream_options).toEqual({ include_usage: true });
		expect(request?.headers.authorization).toBe(`Bearer ${mock.validAccessToken()}`);
		expect(request?.headers["user-agent"]).toMatch(/^Mozilla\/5\.0 \(Windows NT 10\.0/);
	});

	it("sends raccoon_thinking for the selected level", async () => {
		const thinkingModel = model({
			reasoning: true,
			thinkingLevelMap: { off: "level_1", minimal: "level_1", low: "level_1", medium: "level_3", high: "level_5", xhigh: "level_5", max: "level_5" },
		});
		await collect(streamXhx(thinkingModel, userContext, { apiKey: mock.validAccessToken(), reasoning: "medium" }));
		const request = mock.requests.find((r) => r.path.endsWith("/chat/completions"));
		const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
		expect(body.raccoon_thinking).toBe("level_3");
	});

	it("sends the model's floor when no level is selected", async () => {
		const thinkingModel = model({
			reasoning: true,
			thinkingLevelMap: { off: "level_1", minimal: "level_1", low: "level_1", medium: "level_3", high: "level_5", xhigh: "level_5", max: "level_5" },
		});
		await collect(streamXhx(thinkingModel, userContext, { apiKey: mock.validAccessToken() }));
		const request = mock.requests.find((r) => r.path.endsWith("/chat/completions"));
		const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
		expect(body.raccoon_thinking).toBe("level_1");
	});

	it("sends off when the model can disable thinking", async () => {
		const thinkingModel = model({
			reasoning: true,
			thinkingLevelMap: { off: "off", minimal: "level_1", low: "level_1", medium: "level_3", high: "level_5", xhigh: "level_5", max: "level_5" },
		});
		await collect(streamXhx(thinkingModel, userContext, { apiKey: mock.validAccessToken() }));
		const request = mock.requests.find((r) => r.path.endsWith("/chat/completions"));
		const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
		expect(body.raccoon_thinking).toBe("off");
	});

	it("caps the output reservation and identifies as the desktop client", async () => {
		await collect(streamXhx(model({ maxTokens: 100_000 }), userContext, { apiKey: mock.validAccessToken(), maxTokens: 100_000 }));
		const request = mock.requests.find((r) => r.path.endsWith("/chat/completions"));
		const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
		expect(body.max_tokens).toBe(16_384);
		expect(request?.headers["x-org-code"]).toBe("");
		expect(request?.headers["x-raccoon-language"]).toBe("zh");
		expect(request?.headers["x-raccoon-language"]).toBe("zh");
	});

	it("explains a risk-control block", async () => {
		await mock.close();
		mock = await startMockUpstream({ chatMode: "blocked" });
		process.env.XHX_ORIGIN = mock.origin;

		const { final } = await collect(streamXhx(model(), userContext, { apiKey: mock.validAccessToken() }));
		expect(final?.stopReason).toBe("error");
		expect(final?.errorMessage).toContain("200108");
		expect(final?.errorMessage).toContain("问题反馈");
	});

	it("assembles tool calls", async () => {
		const context = normalizeContext({
			messages: [{ role: "user", content: "TOOLCALL read a.txt", timestamp: Date.now() }],
			tools: [
				{
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			],
		});
		const { types, final } = await collect(streamXhx(model(), context, { apiKey: mock.validAccessToken() }));
		expect(types).toContain("toolcall_start");
		expect(types).toContain("toolcall_end");
		expect(final?.stopReason).toBe("toolUse");
		expect(final?.content).toEqual([
			{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } },
		]);
	});

	it("echoes reasoning_content back on assistant history", async () => {
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "第一问", timestamp: Date.now() },
				{
					role: "assistant",
					api: "openai-completions",
					provider: "xhx",
					model: "sn-glm-5-3-flash",
					content: [
						{ type: "thinking", thinking: "先想一想", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "第一答" },
					],
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "第二问", timestamp: Date.now() },
			],
		});
		await collect(streamXhx(model(), context, { apiKey: mock.validAccessToken() }));
		const request = mock.requests.find((r) => r.path.endsWith("/chat/completions"));
		const body = JSON.parse(request?.body ?? "{}") as { messages: Record<string, unknown>[] };
		const assistant = body.messages.find((message) => message.role === "assistant");
		expect(assistant?.content).toBe("第一答");
		expect(assistant?.reasoning_content).toBe("先想一想");
	});

	it("retries without stream_options when the gateway rejects the field", async () => {
		await mock.close();
		mock = await startMockUpstream({ rejectStreamOptions: true });
		process.env.XHX_ORIGIN = mock.origin;

		// Production models carry the compat block, so the retry must override it.
		const { final } = await collect(
			streamXhx(model({ compat: XHX_COMPAT }), userContext, { apiKey: mock.validAccessToken() }),
		);
		expect(final?.stopReason).toBe("stop");
		expect(final?.content).toEqual([
			{ type: "thinking", thinking: "先想一想", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "你好，世界" },
		]);

		const chatRequests = mock.requests.filter((r) => r.path.endsWith("/chat/completions"));
		expect(chatRequests).toHaveLength(2);
		expect(JSON.parse(chatRequests[0]?.body ?? "{}").stream_options).toEqual({ include_usage: true });
		expect(JSON.parse(chatRequests[1]?.body ?? "{}").stream_options).toBeUndefined();
	});

	it("reports an unauthorized request as an error event", async () => {
		const { types, final } = await collect(streamXhx(model(), userContext, { apiKey: "stale-token" }));
		expect(types.at(-1)).toBe("error");
		expect(final?.stopReason).toBe("error");
		expect(final?.errorMessage).toMatch(/401/);
	});

	it("converts cancellation into an aborted result", async () => {
		await mock.close();
		mock = await startMockUpstream({ frameDelayMs: 40 });
		process.env.XHX_ORIGIN = mock.origin;

		const controller = new AbortController();
		const stream = streamXhx(model(), userContext, { apiKey: mock.validAccessToken(), signal: controller.signal });
		setTimeout(() => controller.abort(), 60);
		const { final } = await collect(stream);
		expect(final?.stopReason).toBe("aborted");
	});

	it("handles an empty text response", async () => {
		await mock.close();
		mock = await startMockUpstream({ chatMode: "empty" });
		process.env.XHX_ORIGIN = mock.origin;

		const { final } = await collect(streamXhx(model(), userContext, { apiKey: mock.validAccessToken() }));
		expect(final?.stopReason).toBe("stop");
		expect(final?.content).toEqual([]);
	});

	it("skips a malformed SSE frame and keeps the rest", async () => {
		await mock.close();
		mock = await startMockUpstream({ chatMode: "malformed" });
		process.env.XHX_ORIGIN = mock.origin;

		const { final } = await collect(streamXhx(model(), userContext, { apiKey: mock.validAccessToken() }));
		expect(final?.stopReason).toBe("stop");
		expect(final?.content).toEqual([{ type: "text", text: "你好" }]);
	});

	it("keeps a surrogate pair intact when it spans two frames", async () => {
		await mock.close();
		mock = await startMockUpstream({ chatMode: "unicode" });
		process.env.XHX_ORIGIN = mock.origin;

		const { final } = await collect(streamXhx(model(), userContext, { apiKey: mock.validAccessToken() }));
		expect(final?.content).toEqual([{ type: "text", text: "🙂 done" }]);
	});

	it("reports a stream that dies mid-response", async () => {
		await mock.close();
		mock = await startMockUpstream({ chatMode: "truncate" });
		process.env.XHX_ORIGIN = mock.origin;

		const { types, final } = await collect(streamXhx(model(), userContext, { apiKey: mock.validAccessToken() }));
		expect(types.at(-1)).toBe("error");
		expect(final?.stopReason).toBe("error");
	});

	it("forwards image input as an OpenAI content array", async () => {
		const context = normalizeContext({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "这张图里是什么？" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		});
		await collect(streamXhx(model({ input: ["text", "image"] }), context, { apiKey: mock.validAccessToken() }));
		const request = mock.requests.find((r) => r.path.endsWith("/chat/completions"));
		const body = JSON.parse(request?.body ?? "{}") as { messages: { content: unknown }[] };
		const content = body.messages[0]?.content as { type: string; image_url?: { url: string } }[];
		expect(Array.isArray(content)).toBe(true);
		expect(content.some((part) => part.type === "image_url" && part.image_url?.url.startsWith("data:image/png;base64,"))).toBe(
			true,
		);
	});
});
