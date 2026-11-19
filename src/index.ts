/**
 * pi-provider-xhx — 小浣熊 (SenseTime Raccoon) provider for pi.
 *
 * Registers one provider, `xhx`, that speaks the gateway's OpenAI-compatible
 * Chat Completions surface directly. No local proxy process is involved: the
 * extension holds the OAuth credentials, refreshes them through pi's auth
 * layer, and streams through pi's own `openai-completions` implementation.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { getApiKey, loginXhx, refreshXhx } from "./auth.ts";
import { fetchCatalog, toModelConfigs } from "./catalog.ts";
import { registerCommands } from "./commands.ts";
import { PROVIDER_ID, PROVIDER_NAME, USER_AGENT, llmBase } from "./constants.ts";
import { FALLBACK_MODELS } from "./models.ts";
import { streamXhx } from "./stream.ts";

function tokenFromCredential(context: RefreshModelsContext): string | undefined {
	const credential = context.credential;
	if (credential?.type === "oauth" && typeof credential.access === "string" && credential.access !== "") {
		return credential.access;
	}
	if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key !== "") {
		return credential.key;
	}
	const env = process.env.XHX_ACCESS_TOKEN?.trim();
	return env && env !== "" ? env : undefined;
}

/**
 * Replace the model list with the live catalog.
 *
 * Returning the fallback instead of throwing keeps the model list usable when
 * the gateway is unreachable or the token has lapsed: pi keeps whatever this
 * returns, so an empty array would silently remove every model.
 */
async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	const token = tokenFromCredential(context);
	if (!token || !context.allowNetwork) return FALLBACK_MODELS;
	try {
		const entries = await fetchCatalog(token, context.signal);
		if (entries.length === 0) return FALLBACK_MODELS;
		return toModelConfigs(entries, context.baseUrl ?? llmBase());
	} catch {
		return FALLBACK_MODELS;
	}
}

export default function xhxExtension(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: llmBase(),
		api: "openai-completions",
		apiKey: "$XHX_ACCESS_TOKEN",
		headers: { "User-Agent": USER_AGENT },
		models: FALLBACK_MODELS,
		oauth: {
			name: PROVIDER_NAME,
			login: loginXhx,
			refreshToken: refreshXhx,
			getApiKey,
		},
		refreshModels,
		streamSimple: streamXhx,
	});

	// pi only refreshes provider catalogs over the network after a login or an
	// explicit `pi update --models`, so a fresh session would otherwise keep the
	// fallback list. Ask for one network refresh per session; a failure leaves
	// the fallback in place.
	pi.on("session_start", (_event, ctx) => {
		void ctx.modelRegistry
			.refresh({ allowNetwork: true, providers: [PROVIDER_ID], signal: AbortSignal.timeout(8_000) })
			.catch(() => {});
	});

	registerCommands(pi);
}
