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

function buildOptions(model: Model<Api>, options: SimpleStreamOptions | undefined): SimpleStreamOptions {
	const thinking = thinkingValue(model, options?.reasoning);
	const callerOnPayload = options?.onPayload;
	return {
		...(options ?? {}),
		headers: { "User-Agent": USER_AGENT, ...(options?.headers ?? {}) },
		fetch: withSseSanitizer(options?.fetch ?? globalThis.fetch),
		onPayload: async (payload, target) => {
			if (thinking !== undefined && payload !== null && typeof payload === "object") {
				(payload as Record<string, unknown>).raccoon_thinking = thinking;
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

			if (!first.done) stream.push(first.value);
			for (;;) {
				const next = await iterator.next();
				if (next.done) break;
				stream.push(next.value);
			}
			stream.end();
		} catch (error) {
			stream.push(errorEvent(model, describeFailure(error)));
			stream.end();
		}
	})();

	return stream;
}
