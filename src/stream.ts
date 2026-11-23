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
import { USER_AGENT, llmBaseV1 } from "./constants.ts";

/** The gateway's risk control flags a huge output reservation on every call. */
function maxOutputTokens(): number {
	const raw = process.env.XHX_MAX_TOKENS?.trim();
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 16_384;
}

function minRequestIntervalMs(): number {
	const raw = process.env.XHX_MIN_INTERVAL_MS?.trim();
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 400;
}

let lastRequestAt = 0;

async function throttle(): Promise<void> {
	const interval = minRequestIntervalMs();
	if (interval <= 0) return;
	const wait = lastRequestAt + interval - Date.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	lastRequestAt = Date.now();
}

/**
 * Header set the official web/desktop client sends on every model call:
 * `Authorization`, `Content-Type`, `X-Org-Code`, `X-Raccoon-Language`.
 */
function clientHeaders(apiKey: string, extra: Record<string, string | null> | undefined): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
		"User-Agent": USER_AGENT,
		"X-Org-Code": process.env.XHX_ORG_CODE?.trim() ?? "",
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
	choices?: {
		finish_reason?: string;
		message?: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
		};
	}[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
	};
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

function usageFrom(response: CompletionResponse): Usage {
	const usage = response.usage ?? {};
	return {
		input: usage.prompt_tokens ?? 0,
		output: usage.completion_tokens ?? 0,
		cacheRead: usage.prompt_tokens_details?.cached_tokens ?? 0,
		cacheWrite: 0,
		totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function parseArguments(raw: string | undefined): ToolCall["arguments"] {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ToolCall["arguments"]) : {};
	} catch {
		return {};
	}
}

/**
 * A half-finished `npm install` in the shared extension root leaves the `openai`
 * SDK missing files, and the raw error ("Cannot find module
 * './internal/auth/x509-api-origin.js'") says nothing about what to do.
 */
function describeFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/Cannot find module/.test(message) && /[\\/]openai[\\/]/.test(message)) {
		return `${message}\n\nThe openai SDK in the shared extension install is incomplete — an install was interrupted. Run \`pi update --extensions\` (or reinstall the package) and retry.`;
	}
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

			const tools = context.messages.flatMap((message) =>
				message.role === "system" && message.toolsAdded ? message.toolsAdded : [],
			);
			const thinking = thinkingValue(model, options?.reasoning);
			const body: Record<string, unknown> = {
				model: model.id,
				messages: toOpenAIMessages(context.messages),
				stream: false,
				max_tokens: Math.min(options?.maxTokens ?? model.maxTokens, maxOutputTokens()),
				verbose: true,
			};
			if (tools.length > 0) body.tools = toOpenAITools(tools);
			if (thinking !== undefined) body.raccoon_thinking = thinking;
			if (options?.temperature !== undefined) body.temperature = options.temperature;

			const payload = options?.onPayload ? ((await options.onPayload(body, model)) ?? body) : body;

			await throttle();
			const response = await fetch(`${llmBaseV1()}/chat/completions`, {
				method: "POST",
				headers: clientHeaders(apiKey, options?.headers),
				body: JSON.stringify(payload),
				...(options?.signal ? { signal: options.signal } : {}),
			});
			options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);

			const raw = await response.text();
			if (!response.ok) throw new Error(`${response.status}: ${raw.slice(0, 600)}`);

			let parsed: CompletionResponse;
			try {
				parsed = JSON.parse(raw) as CompletionResponse;
			} catch {
				throw new Error(`响应不是合法 JSON：${raw.slice(0, 200)}`);
			}

			const choice = parsed.choices?.[0];
			const message = choice?.message ?? {};
			const text = message.content ?? "";
			const reasoning = message.reasoning_content ?? "";
			const calls = message.tool_calls ?? [];

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
					arguments: parseArguments(call.function?.arguments),
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

			output.stopReason = calls.length > 0 ? "toolUse" : choice?.finish_reason === "length" ? "length" : "stop";
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
