/**
 * Wire-compatibility flags for the 小浣熊 gateway.
 *
 * pi's `openai-completions` implementation auto-detects compatibility from the
 * provider id and base URL. `xiaohuanxiong.com` matches none of its known
 * hosts, so the detected defaults would be the strict-OpenAI ones:
 *
 *   supportsStore: true            -> sends `store: false`
 *   supportsDeveloperRole: true    -> sends `role: "developer"` instead of `system`
 *   supportsReasoningEffort: true  -> sends `reasoning_effort`
 *   maxTokensField: max_completion_tokens
 *
 * The gateway is a proxy in front of several vendors' models and only
 * guarantees the classic Chat Completions surface, so every one of those is
 * turned off. `stream_options` is kept because usage accounting depends on it;
 * `stream.ts` retries without it if the gateway rejects the field.
 */

import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai/compat";

export const XHX_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: false,
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresNonNullAssistantContent: false,
	requiresToolsWithToolHistory: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
};

/** Same flags with `stream_options` dropped, for the retry path. */
export const XHX_COMPAT_NO_STREAM_OPTIONS: OpenAICompletionsCompat = {
	...XHX_COMPAT,
	supportsUsageInStreaming: false,
};
