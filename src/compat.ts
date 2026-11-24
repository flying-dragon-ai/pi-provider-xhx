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
 * turned off. The active non-streaming adapter does not send `stream_options`.
 */

import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai/compat";

export const XHX_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
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
