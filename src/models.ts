/**
 * Offline fallback catalog.
 *
 * Used before the first successful `refreshModels` (fresh install, no network,
 * expired token). The live catalog replaces it as soon as one fetch succeeds,
 * and it is restored whenever a later fetch fails so the model list never goes
 * empty mid-session.
 *
 * Ids are the upstream ids — the gateway does no aliasing.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, llmBase } from "./constants.ts";
import { XHX_COMPAT } from "./compat.ts";

interface FallbackModel {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
}

const FALLBACK: FallbackModel[] = [
	{ id: "sn-glm-5-3-flash", name: "GLM-5.3 Flash" },
	{ id: "sn-glm-5-3", name: "GLM-5.3" },
	{ id: "sn-kimi-k3", name: "Kimi K3" },
	{ id: "sn-deepseek-v4-1-flash", name: "DeepSeek V4.1 Flash" },
	{ id: "sn-sensenova-6-8-flash", name: "SenseNova 6.8 Flash" },
	{ id: "sn-sensenova-6-8-flash-lite", name: "SenseNova 6.8 Flash Lite" },
];

export const FALLBACK_MODELS: ProviderModelConfig[] = FALLBACK.map((model) => ({
	id: model.id,
	name: model.name,
	reasoning: false,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
	maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
	baseUrl: llmBase(),
	compat: XHX_COMPAT,
}));
