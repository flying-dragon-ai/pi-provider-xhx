/**
 * Live model catalog: `GET {llm_base}/model_catalog`.
 *
 * Parsing rules are the ones the Go proxy settled on after testing the real
 * endpoint:
 *   - the payload may be `{data:{categories:[…]}}` or the categories object itself
 *   - every `categories[].models[]` entry is flattened
 *   - the first entry wins for a duplicated name; entries without a name are dropped
 *   - `context_window` / `max_tokens` are read from the entry, then from `params`
 *   - `visible` defaults to true
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, llmBase } from "./constants.ts";
import { XHX_COMPAT } from "./compat.ts";

/**
 * Thinking control, as the catalog describes it under `params.raccoon_thinking`.
 *
 * The gateway takes a `raccoon_thinking` request field whose values are the
 * `display_levels` entries (`level_1` … `level_5`). `can_disable` says whether
 * `"off"` is accepted; when it is false the lowest level is the floor.
 */
export interface ThinkingConfig {
	supported: boolean;
	canDisable: boolean;
	levels: string[];
	defaultLevel: string;
}

export interface CatalogEntry {
	id: string;
	name: string;
	description: string;
	tags: string[];
	contextWindow?: number;
	maxTokens?: number;
	visible: boolean;
	thinking?: ThinkingConfig;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
	}
	return undefined;
}

function truncate(value: string, max: number): string {
	const chars = [...value];
	return chars.length <= max ? value : chars.slice(0, max).join("");
}

function normalizeEntry(raw: unknown): CatalogEntry | undefined {
	const entry = asRecord(raw);
	const id = asString(entry.name) || asString(entry.model_name);
	if (id === "") return undefined;

	const codename = asString(entry.description);
	const displayDescription = asString(entry.display_description);
	const name = truncate(displayDescription, 64) || codename || id;
	const description = displayDescription || codename;

	const params = asRecord(entry.params);
	const contextWindow = asNumber(entry.context_window) ?? asNumber(params.context_window);
	const maxTokens = asNumber(entry.max_tokens) ?? asNumber(params.max_tokens);
	const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
	const visible = typeof entry.visible === "boolean" ? entry.visible : true;

	const normalized: CatalogEntry = { id, name, description, tags, visible };
	if (contextWindow !== undefined) normalized.contextWindow = contextWindow;
	if (maxTokens !== undefined) normalized.maxTokens = maxTokens;

	const thinking = asRecord(params.raccoon_thinking);
	if (thinking.supported === true) {
		const levels = Array.isArray(thinking.display_levels)
			? thinking.display_levels.map((level) => asString(asRecord(level).value)).filter((level) => level !== "")
			: [];
		if (levels.length > 0) {
			normalized.thinking = {
				supported: true,
				canDisable: thinking.can_disable === true,
				levels,
				defaultLevel: asString(thinking.default_level) || levels[0] || "",
			};
		}
	}
	return normalized;
}

/** Parse a catalog payload into a de-duplicated, order-preserving list. */
export function parseCatalog(payload: unknown): CatalogEntry[] {
	const root = asRecord(payload);
	const data = root.data;
	const container = data && typeof data === "object" ? asRecord(data) : root;
	const categories = Array.isArray(container.categories) ? container.categories : [];

	const entries: CatalogEntry[] = [];
	const seen = new Set<string>();
	for (const category of categories) {
		const models = asRecord(category).models;
		if (!Array.isArray(models)) continue;
		for (const model of models) {
			const entry = normalizeEntry(model);
			if (!entry || seen.has(entry.id)) continue;
			seen.add(entry.id);
			entries.push(entry);
		}
	}
	return entries;
}

/** Fetch the catalog with a bearer token. Throws on transport or upstream errors. */
export async function fetchCatalog(accessToken: string, signal?: AbortSignal): Promise<CatalogEntry[]> {
	const response = await fetch(`${llmBase()}/model_catalog`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
		...(signal ? { signal } : {}),
	});
	const raw = await response.text();
	if (!response.ok) {
		throw new Error(`拉取模型目录失败：HTTP ${response.status} ${raw.slice(0, 200)}`);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new Error("拉取模型目录失败：响应不是合法 JSON");
	}
	const envelope = asRecord(payload);
	if (typeof envelope.code === "number" && envelope.code !== 0) {
		throw new Error(`拉取模型目录失败：code=${envelope.code} ${asString(envelope.message)}`);
	}
	return parseCatalog(payload);
}

/**
 * Map catalog entries to pi model configs.
 *
 * Cost is zero on purpose: the gateway bills in points, not in USD per token,
 * so any non-zero figure would be a fabrication. Token counts still show up in
 * the footer because usage is parsed from the stream.
 */
export function toModelConfigs(entries: CatalogEntry[], baseUrl = llmBase()): ProviderModelConfig[] {
	return entries
		.filter((entry) => entry.visible)
		.map((entry) => {
			const thinking = entry.thinking;
			const config: ProviderModelConfig = {
				id: entry.id,
				name: entry.name,
				reasoning: thinking !== undefined,
				input: ["text", "image"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
				maxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS,
				baseUrl,
				compat: XHX_COMPAT,
			};
			if (thinking) config.thinkingLevelMap = buildThinkingLevelMap(thinking);
			return config;
		});
}

/**
 * Map pi's thinking levels onto the gateway's `raccoon_thinking` values.
 *
 * The catalog lists the levels a model accepts (`level_1` … `level_5`, sometimes
 * a subset). `off` is only offered when the model says it can be disabled;
 * otherwise the lowest level is the floor, because the gateway always reasons.
 */
export function buildThinkingLevelMap(thinking: ThinkingConfig): ThinkingLevelMap {
	const levels = thinking.levels;
	const last = levels.length - 1;
	const pick = (index: number): string => levels[Math.min(Math.max(index, 0), last)] ?? levels[0] ?? "";
	return {
		off: thinking.canDisable ? "off" : pick(0),
		minimal: pick(0),
		low: pick(Math.floor(last / 3)),
		medium: pick(Math.floor(last / 2)),
		high: pick(last),
		xhigh: pick(last),
		max: pick(last),
	};
}
