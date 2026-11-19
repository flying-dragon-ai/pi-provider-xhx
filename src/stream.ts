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

function withHeaders(options: SimpleStreamOptions | undefined): SimpleStreamOptions {
	return {
		...(options ?? {}),
		headers: { "User-Agent": USER_AGENT, ...(options?.headers ?? {}) },
	};
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
		const requestOptions = withHeaders(options);
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
			stream.push(errorEvent(model, error instanceof Error ? error.message : String(error)));
			stream.end();
		}
	})();

	return stream;
}
