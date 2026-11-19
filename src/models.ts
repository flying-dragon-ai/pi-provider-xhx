/**
 * Offline fallback catalog.
 *
 * Used before the first successful `refreshModels` (fresh install, no network,
 * expired token). The live catalog replaces it as soon as one fetch succeeds,
 * and it is restored whenever a later fetch fails so the model list never goes
 * empty mid-session.
 *
 * Ids, limits, and thinking levels mirror the live catalog as of 2026-11-19.
 * The gateway does no aliasing, so these are the upstream ids verbatim.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { buildThinkingLevelMap, type ThinkingConfig } from "./catalog.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, llmBase } from "./constants.ts";
import { XHX_COMPAT } from "./compat.ts";

interface FallbackModel {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
	thinking: ThinkingConfig;
}

const THREE_LEVELS = ["level_1", "level_3", "level_5"];
const FIVE_LEVELS = ["level_1", "level_2", "level_3", "level_4", "level_5"];

function thinking(levels: string[], canDisable: boolean): ThinkingConfig {
	return { supported: true, canDisable, levels, defaultLevel: canDisable ? "off" : levels[0] ?? "" };
}

const FALLBACK: FallbackModel[] = [
	{
		id: "sn-glm-5-3-flash",
		name: "GLM-5.3 Flash",
		contextWindow: 1_000_000,
		maxTokens: 100_000,
		thinking: thinking(THREE_LEVELS, false),
	},
	{
		id: "sn-glm-5-3",
		name: "GLM-5.3",
		contextWindow: 1_000_000,
		maxTokens: 100_000,
		thinking: thinking(THREE_LEVELS, false),
	},
	{
		id: "sn-qwen4-max",
		name: "Qwen4 Max",
		contextWindow: 1_000_000,
		maxTokens: 100_000,
		thinking: thinking(THREE_LEVELS, true),
	},
	{
		id: "sn-kimi-k3-1-pro",
		name: "Kimi K3.1 Pro",
		contextWindow: 1_000_000,
		maxTokens: 100_000,
		thinking: thinking(THREE_LEVELS, false),
	},
	{
		id: "sn-deepseek-v4-1-flash-1017",
		name: "DeepSeek V4.1 Flash",
		contextWindow: 1_000_000,
		maxTokens: 100_000,
		thinking: thinking(THREE_LEVELS, true),
	},
	{
		id: "sn-sensenova-6-8-flash",
		name: "SenseNova 6.8 Flash",
		contextWindow: 256_000,
		maxTokens: 63_999,
		thinking: thinking(FIVE_LEVELS, false),
	},
	{
		id: "sn-sensenova-6-8-flash-lite",
		name: "SenseNova 6.8 Flash Lite",
		contextWindow: 256_000,
		maxTokens: 63_999,
		thinking: thinking(["level_1", "level_2", "level_4", "level_5"], true),
	},
];

export const FALLBACK_MODELS: ProviderModelConfig[] = FALLBACK.map((model) => ({
	id: model.id,
	name: model.name,
	reasoning: true,
	thinkingLevelMap: buildThinkingLevelMap(model.thinking),
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
	maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
	baseUrl: llmBase(),
	compat: XHX_COMPAT,
}));
