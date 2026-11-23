/**
 * Streaming entry point.
 *
 * pi's `openai-completions` implementation does the real work: message
 * conversion, tool-call assembly, usage accounting, cancellation. This wrapper
 * only adds what the gateway needs on top:
 *
 *   - the provider's compatibility flags (see `compat.ts`)
 *   - a `User-Agent` the gateway accepts
 *   - one retry without `stream_options` when the gateway rejects that field
 *
 * The retry is safe because a rejected request fails before any content event:
 * the wrapper buffers the first event and only replays it when it is not a
 * parameter error.
 */

import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	createAssistantMessageEventStream,
	openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import { USER_AGENT } from "./constants.ts";
import { XHX_COMPAT, XHX_COMPAT_NO_STREAM_OPTIONS } from "./compat.ts";
import { withSseSanitizer } from "./sse.ts";

/** Fields the gateway may reject; only these trigger the retry. */
const RETRYABLE_FIELD = /stream_options|include_usage/i;

export function isStreamOptionsRejection(message: string | undefined): boolean {
	if (!message) return false;
	if (!RETRYABLE_FIELD.test(message)) return false;
	return /400|invalid|unknown|unsupported|unrecognized|not support|extra fields/i.test(message);
}

function withCompat(model: Model<Api>, compat: typeof XHX_COMPAT): Model<Api> {
	const existing = (model as { compat?: Record<string, unknown> }).compat ?? {};
	// The explicit flags win: a retry must be able to turn a field off even when
	// the model config already carries the default set.
	return { ...model, compat: { ...existing, ...compat } } as Model<Api>;
}

/**
 * The gateway's thinking field. pi has no `thinkingFormat` for it, so the value
 * is derived from the model's `thinkingLevelMap` and injected into the payload.
 */
function thinkingValue(model: Model<Api>, level: SimpleStreamOptions["reasoning"]): string | undefined {
	const map = model.thinkingLevelMap;
	if (!map) return undefined;
	// pi has no "off" level: an absent level means the user turned thinking off,
	// so the model's own off value (or its floor) is what gets sent.
	const mapped = level ? map[level] : map.off;
	return typeof mapped === "string" && mapped !== "" ? mapped : undefined;
}

/**
 * The gateway's risk control flags accounts that look like a scraper: bursts of
 * requests, or a huge output reservation on every call. The official client
 * sends a few thousand `max_new_tokens` and one request at a time, so the
 * extension keeps its own requests in that shape.
 */
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

/** Space requests out so a tool-call loop cannot look like a burst. */
function withThrottle(inner: typeof globalThis.fetch, intervalMs: number): typeof globalThis.fetch {
	if (intervalMs <= 0) return inner;
	return async (input, init) => {
		const wait = lastRequestAt + intervalMs - Date.now();
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		lastRequestAt = Date.now();
		return inner(input, init);
	};
}

function buildOptions(model: Model<Api>, options: SimpleStreamOptions | undefined): SimpleStreamOptions {
	const thinking = thinkingValue(model, options?.reasoning);
	const callerOnPayload = options?.onPayload;
	const cap = maxOutputTokens();
	return {
		...(options ?? {}),
		headers: {
			"User-Agent": USER_AGENT,
			// The desktop client identifies itself on every call; matching it keeps
			// the request looking like first-party traffic.
			"X-Client-Platform": "desktop-windows",
			"X-Client-Version": "v1.0.0",
			"X-Raccoon-Language": "zh",
			...(options?.headers ?? {}),
		},
		fetch: withThrottle(withSseSanitizer(options?.fetch ?? globalThis.fetch), minRequestIntervalMs()),
		onPayload: async (payload, target) => {
			if (payload !== null && typeof payload === "object") {
				const body = payload as Record<string, unknown>;
				if (thinking !== undefined) body.raccoon_thinking = thinking;
				if (typeof body.max_tokens === "number" && body.max_tokens > cap) body.max_tokens = cap;
			}
			if (!callerOnPayload) return payload;
			const replaced = await callerOnPayload(payload, target);
			return replaced ?? payload;
		},
	};
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

/** Rewrite an error event's message when the gateway's failure needs context. */
function explain(event: AssistantMessageEvent): AssistantMessageEvent {
	if (event.type !== "error") return event;
	const original = event.error.errorMessage ?? "";
	const explained = describeFailure(original);
	if (explained === original) return event;
	return { ...event, error: { ...event.error, errorMessage: explained } };
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
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: message,
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
		const requestOptions = buildOptions(model, options);
		try {
			const inner = openAICompletionsApi().streamSimple(withCompat(model, XHX_COMPAT), context, requestOptions);
			const iterator = inner[Symbol.asyncIterator]();
			const first = await iterator.next();

			if (!first.done && first.value.type === "error" && isStreamOptionsRejection(first.value.error.errorMessage)) {
				const retry = openAICompletionsApi().streamSimple(
					withCompat(model, XHX_COMPAT_NO_STREAM_OPTIONS),
					context,
					requestOptions,
				);
				for await (const event of retry) stream.push(event);
				stream.end();
				return;
			}

			if (!first.done) stream.push(explain(first.value));
			for (;;) {
				const next = await iterator.next();
				if (next.done) break;
				stream.push(explain(next.value));
			}
			stream.end();
		} catch (error) {
			stream.push(errorEvent(model, describeFailure(error)));
			stream.end();
		}
	})();

	return stream;
}
