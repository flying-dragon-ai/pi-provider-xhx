/**
 * Streaming entry point.
 *
 * The gateway's `/llm/v2/chat/completions` endpoint is behind a risk control
 * that flags accounts using it from anything but the official client, and its
 * `/llm/v1/chat/completions` streaming path answers `invalid upstream stream
 * response`. The v1 endpoint's non-streaming path works and returns the full
 * OpenAI shape — content, `reasoning_content`, tool calls, usage — so the
 * extension calls that and synthesizes pi's event stream from the response.
 *
 * The trade-off is that text arrives in one block instead of token by token.
 * Everything else (tool calls, thinking, usage, cancellation) behaves the same.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type Tool,
	type ToolCall,
	type TranscriptContext,
	type Usage,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/compat";
import { parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";
import { resolveTranscript, resolveTranscriptTools } from "@earendil-works/pi-ai/utils/transcript";
import { USER_AGENT, llmBaseV1, resolveOrigin } from "./constants.ts";

/** The gateway's risk control flags a huge output reservation on every call. */
function maxOutputTokens(env?: Record<string, string>): number {
	const raw = (env?.XHX_MAX_TOKENS ?? process.env.XHX_MAX_TOKENS)?.trim();
	const parsed = raw ? Number(raw) : Number.NaN;
	const integer = Math.trunc(parsed);
	return Number.isFinite(parsed) && integer > 0 ? integer : 16_384;
}

function minRequestIntervalMs(env?: Record<string, string>): number {
	const raw = (env?.XHX_MIN_INTERVAL_MS ?? process.env.XHX_MIN_INTERVAL_MS)?.trim();
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? Math.max(0, Math.trunc(parsed)) : 400;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	const activeSignal = signal;
	if (activeSignal.aborted) return Promise.reject(activeSignal.reason ?? new Error("Request was aborted"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(onDone, ms);
		function cleanup() {
			clearTimeout(timer);
			activeSignal.removeEventListener("abort", onAbort);
		}
		function onDone() {
			cleanup();
			resolve();
		}
		function onAbort() {
			cleanup();
			reject(activeSignal.reason ?? new Error("Request was aborted"));
		}
		activeSignal.addEventListener("abort", onAbort, { once: true });
		if (activeSignal.aborted) onAbort();
	});
}

let lastRequestAt = 0;
let throttleQueue: Promise<void> = Promise.resolve();

async function throttle(signal?: AbortSignal, env?: Record<string, string>): Promise<void> {
	if (signal?.aborted) throw signal.reason ?? new Error("Request was aborted");
	const interval = minRequestIntervalMs(env);
	if (interval <= 0) return;
	const run = throttleQueue.then(async () => {
		if (signal?.aborted) throw signal.reason ?? new Error("Request was aborted");
		const wait = lastRequestAt + interval - Date.now();
		if (wait > 0) await sleep(wait, signal);
		lastRequestAt = Date.now();
	});
	// A cancelled waiter must not poison the queue for every later request.
	throttleQueue = run.catch(() => {});
	await run;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return signal;
	const timeout = AbortSignal.timeout(Math.max(1, Math.trunc(timeoutMs)));
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Header set the official web/desktop client sends on every model call:
 * `Authorization`, `Content-Type`, `X-Org-Code`, `X-Raccoon-Language`.
 */
function clientHeaders(
	apiKey: string,
	extra: Record<string, string | null> | undefined,
	env?: Record<string, string>,
): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
		"User-Agent": USER_AGENT,
		"X-Org-Code": (env?.XHX_ORG_CODE ?? process.env.XHX_ORG_CODE)?.trim() ?? "",
		"X-Raccoon-Language": "zh",
		...Object.fromEntries(Object.entries(extra ?? {}).filter(([, value]) => value !== null)),
	};
}

/** The gateway's thinking field, mapped from pi's level through the model's map. */
function thinkingValue(model: Model<Api>, level: SimpleStreamOptions["reasoning"]): string | undefined {
	const map = model.thinkingLevelMap;
	if (!map) return undefined;
	// pi has no "off" level: an absent level means the user turned thinking off,
	// so the model's own off value (or its floor) is what gets sent.
	const mapped = level ? map[level] : map.off;
	return typeof mapped === "string" && mapped !== "" ? mapped : undefined;
}

function textOf(content: string | TextContent[]): string {
	return typeof content === "string" ? content : content.map((part) => part.text).join("\n");
}

function imageUrl(part: ImageContent): string {
	return `data:${part.mimeType};base64,${part.data}`;
}

type OpenAIMessage = Record<string, unknown>;

/** Convert pi's transcript into the OpenAI chat shape the gateway accepts. */
export function toOpenAIMessages(messages: readonly Message[]): OpenAIMessage[] {
	const out: OpenAIMessage[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			const sections = message.sections
				? Object.entries(message.sections)
						.filter(([, value]) => value !== null)
						.map(([name, value]) => `${name}: ${value}`)
						.join("\n")
				: "";
			const body = [textOf(message.content), sections].filter((part) => part !== "").join("\n\n");
			if (body !== "") out.push({ role: "system", content: body });
			continue;
		}
		if (message.role === "user") {
			if (typeof message.content === "string") {
				out.push({ role: "user", content: message.content });
			} else {
				out.push({
					role: "user",
					content: message.content.map((part) =>
						part.type === "text"
							? { type: "text", text: part.text }
							: { type: "image_url", image_url: { url: imageUrl(part) } },
					),
				});
			}
			continue;
		}
		if (message.role === "assistant") {
			const text = message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("");
			const thinking = message.content
				.filter((part) => part.type === "thinking")
				.map((part) => (part as { thinking: string }).thinking)
				.join("\n");
			const toolCalls = message.content
				.filter((part): part is ToolCall => part.type === "toolCall")
				.map((call) => ({
					id: call.id,
					type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.arguments) },
				}));
			if (text === "" && toolCalls.length === 0) continue;
			const entry: OpenAIMessage = { role: "assistant", content: text };
			if (thinking !== "") entry.reasoning_content = thinking;
			if (toolCalls.length > 0) entry.tool_calls = toolCalls;
			out.push(entry);
			continue;
		}
		const result = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		out.push({
			role: "tool",
			tool_call_id: message.toolCallId,
			content: result === "" ? (message.isError ? "error" : "") : result,
		});
	}
	return out;
}

/** Convert pi's tool declarations into OpenAI function tools. */
export function toOpenAITools(tools: readonly Tool[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	}));
}

interface CompletionResponse {
	id?: string;
	model?: string;
	choices: {
		finish_reason?: string | null;
		message: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
		};
	}[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCompletion(raw: string): CompletionResponse {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`响应不是合法 JSON：${raw.slice(0, 200)}`);
	}
	if (!isRecord(value)) throw new Error("上游响应不是 JSON 对象");

	const code = value.code;
	if ((typeof code === "number" && code !== 0) || (typeof code === "string" && code !== "" && code !== "0")) {
		const error = isRecord(value.error) ? value.error : {};
		const detail = value.message ?? value.msg ?? error.message ?? "";
		throw new Error(`上游错误：code=${String(code)} ${String(detail)}`.trim());
	}
	if (!Array.isArray(value.choices) || value.choices.length === 0 || !isRecord(value.choices[0])) {
		throw new Error(`上游响应缺少 choices：${raw.slice(0, 200)}`);
	}
	const choice = value.choices[0];
	if (!isRecord(choice.message)) throw new Error("上游响应缺少 choices[0].message");
	if (choice.finish_reason !== undefined && choice.finish_reason !== null && typeof choice.finish_reason !== "string") {
		throw new Error("上游 finish_reason 不是字符串");
	}
	for (const field of ["content", "reasoning_content"] as const) {
		const fieldValue = choice.message[field];
		if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== "string") {
			throw new Error(`上游 message.${field} 不是字符串`);
		}
	}
	if (choice.message.tool_calls !== undefined) {
		if (!Array.isArray(choice.message.tool_calls)) throw new Error("上游 message.tool_calls 不是数组");
		for (const call of choice.message.tool_calls) {
			if (!isRecord(call)) throw new Error("上游 tool_call 不是对象");
			if (call.id !== undefined && typeof call.id !== "string") throw new Error("上游 tool_call.id 不是字符串");
			if (call.function !== undefined && !isRecord(call.function)) throw new Error("上游 tool_call.function 不是对象");
			if (isRecord(call.function)) {
				if (call.function.name !== undefined && typeof call.function.name !== "string") {
					throw new Error("上游 tool_call.function.name 不是字符串");
				}
				if (call.function.arguments !== undefined && typeof call.function.arguments !== "string") {
					throw new Error("上游 tool_call.function.arguments 不是字符串");
				}
			}
		}
	}
	return value as unknown as CompletionResponse;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function usageFrom(response: CompletionResponse): Usage {
	const usage = response.usage ?? {};
	const prompt = tokenCount(usage.prompt_tokens);
	const cacheRead = tokenCount(usage.prompt_tokens_details?.cached_tokens);
	const cacheWrite = tokenCount(usage.prompt_tokens_details?.cache_write_tokens);
	const input = Math.max(0, prompt - cacheRead - cacheWrite);
	const output = tokenCount(usage.completion_tokens);
	const result: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (usage.completion_tokens_details) {
		result.reasoning = tokenCount(usage.completion_tokens_details.reasoning_tokens);
	}
	return result;
}

function finishStopReason(reason: string | null | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "stop":
		case "end":
			return "stop";
		case "length":
			return "length";
		case "function_call":
		case "tool_calls":
			return "toolUse";
		case undefined:
		case null:
			throw new Error("上游响应缺少 finish_reason");
		default:
			throw new Error(`Provider finish_reason: ${reason}`);
	}
}

function describeFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("200108")) {
		return `${message}\n\nThe gateway has flagged this account for abnormal usage and blocked model calls. It does not clear on its own in a reasonable time: open the 小浣熊 app, click the avatar in the bottom-left, choose 「问题反馈」 and ask them to lift the restriction — or sign in with another account.`;
	}
	return message;
}

function errorEvent(model: Model<Api>, message: string): AssistantMessageEvent {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	};
}

function abortedEvent(model: Model<Api>): AssistantMessageEvent {
	return {
		type: "error",
		reason: "aborted",
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		},
	};
}

export function streamXhx(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("No 小浣熊 access token. Run /login xhx or set XHX_ACCESS_TOKEN.");

			const normalized = resolveTranscript(context, false);
			const tools = resolveTranscriptTools(normalized.messages, "none").requestTools;
			const thinking = thinkingValue(model, options?.reasoning);
			const requestedMaxTokens = Math.trunc(options?.maxTokens ?? model.maxTokens);
			const body: Record<string, unknown> = {
				model: model.id,
				messages: toOpenAIMessages(normalized.messages),
				stream: false,
				max_tokens: Math.min(requestedMaxTokens > 0 ? requestedMaxTokens : model.maxTokens, maxOutputTokens(options?.env)),
				verbose: true,
			};
			if (tools.length > 0) {
				body.tools = toOpenAITools(tools);
				if (options?.toolChoice !== undefined) body.tool_choice = options.toolChoice;
			}
			if (thinking !== undefined) body.raccoon_thinking = thinking;
			if (options?.temperature !== undefined) body.temperature = options.temperature;
			Object.assign(
				body,
				model.samplingParams,
				model.samplingParamsByThinkingLevel?.[options?.reasoning ?? "off"],
				options?.samplingParams,
			);

			const payload = options?.onPayload ? ((await options.onPayload(body, model)) ?? body) : body;

			await throttle(options?.signal, options?.env);
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const response = await fetchImpl(`${llmBaseV1(resolveOrigin(options?.env))}/chat/completions`, {
				method: "POST",
				headers: clientHeaders(apiKey, { ...model.headers, ...options?.headers }, options?.env),
				body: JSON.stringify(payload),
				signal: requestSignal(options?.signal, options?.timeoutMs),
			});
			await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);

			const raw = await response.text();
			if (!response.ok) throw new Error(`${response.status}: ${raw.slice(0, 600)}`);
			const parsed = parseCompletion(raw);
			await options?.onProviderStreamEvent?.(parsed, model);

			const choice = parsed.choices[0];
			if (!choice) throw new Error("上游响应缺少 choices[0]");
			const message = choice.message;
			const text = message.content ?? "";
			const reasoning = message.reasoning_content ?? "";
			const calls = message.tool_calls ?? [];
			const stopReason = finishStopReason(choice.finish_reason);

			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usageFrom(parsed),
				stopReason: "pending",
				timestamp: Date.now(),
			};
			if (parsed.id) output.responseId = parsed.id;
			if (parsed.model && parsed.model !== model.id) output.responseModel = parsed.model;
			if (thinking) output.providerThinkingLevel = thinking;
			if (choice.finish_reason) output.rawStopReason = choice.finish_reason;

			stream.push({ type: "start", partial: output });

			if (reasoning !== "") {
				const block = { type: "thinking" as const, thinking: "", thinkingSignature: "reasoning_content" };
				output.content.push(block);
				const index = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex: index, partial: output });
				block.thinking = reasoning;
				stream.push({ type: "thinking_delta", contentIndex: index, delta: reasoning, partial: output });
				stream.push({ type: "thinking_end", contentIndex: index, content: reasoning, partial: output });
			}

			if (text !== "") {
				const block = { type: "text" as const, text: "" };
				output.content.push(block);
				const index = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: index, partial: output });
				block.text = text;
				stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
				stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
			}

			for (const [position, call] of calls.entries()) {
				const toolCall: ToolCall = {
					type: "toolCall",
					id: call.id ?? `call_${position}`,
					name: call.function?.name ?? "",
					...parseToolCallArguments(call.function?.arguments),
				};
				output.content.push(toolCall);
				const index = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: index,
					delta: call.function?.arguments ?? "",
					partial: output,
				});
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
			}

			if (options?.signal?.aborted) {
				stream.push(abortedEvent(model));
				stream.end();
				return;
			}

			output.stopReason = stopReason;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			if (options?.signal?.aborted) {
				stream.push(abortedEvent(model));
			} else {
				stream.push(errorEvent(model, describeFailure(error)));
			}
			stream.end();
		}
	})();

	return stream;
}
