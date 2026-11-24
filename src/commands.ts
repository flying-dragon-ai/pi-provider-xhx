/**
 * Slash commands. They exist so the account state is reachable from inside pi
 * without a second terminal: `/xhx` for status, `/xhx-balance` for points,
 * `/xhx-checkin` for the daily grant, `/xhx-models` for the live catalog.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { claimDailyGrant, fetchBalance } from "./api.ts";
import { PROVIDER_ID, PROVIDER_NAME, llmBase, llmBaseV1, resolveOrigin } from "./constants.ts";
import { tokenTail } from "./jwt.ts";

async function accessToken(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
	return token && token.trim() !== "" ? token.trim() : undefined;
}

function requireToken(ctx: ExtensionCommandContext, token: string | undefined): token is string {
	if (token) return true;
	ctx.ui.notify(`未登录 ${PROVIDER_NAME}：先运行 /login ${PROVIDER_ID}`, "warning");
	return false;
}

function formatBalance(balance: Awaited<ReturnType<typeof fetchBalance>>): string {
	const parts: string[] = [];
	if (balance.available !== undefined) parts.push(`可用 ${balance.available}`);
	if (balance.daily !== undefined) parts.push(`每日 ${balance.daily}`);
	if (balance.monthly !== undefined) parts.push(`每月 ${balance.monthly}`);
	if (balance.reward !== undefined) parts.push(`奖励 ${balance.reward}`);
	if (balance.topup !== undefined) parts.push(`充值 ${balance.topup}`);
	return parts.length > 0 ? parts.join(" · ") : "上游未返回积分字段";
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("xhx", {
		description: `小浣熊账号状态（${PROVIDER_NAME}）`,
		handler: async (_args, ctx) => {
			const status = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
			const token = await accessToken(ctx);
			const models = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID);
			const lines = [
				`provider: ${PROVIDER_ID}`,
				`origin:   ${resolveOrigin()}`,
				`chat:     ${llmBaseV1()}`,
				`catalog:  ${llmBase()}`,
				`auth:     ${status.configured ? (status.source ?? "configured") : "未登录"}`,
				`token:    ${token ? `…${tokenTail(token)}` : "—"}`,
				`models:   ${models.length}`,
			];
			if (token) {
				try {
					lines.push(`points:   ${formatBalance(await fetchBalance(token))}`);
				} catch (error) {
					lines.push(`points:   查询失败（${error instanceof Error ? error.message : String(error)}）`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("xhx-balance", {
		description: "查询小浣熊积分余额",
		handler: async (_args, ctx) => {
			const token = await accessToken(ctx);
			if (!requireToken(ctx, token)) return;
			try {
				ctx.ui.notify(formatBalance(await fetchBalance(token)), "info");
			} catch (error) {
				ctx.ui.notify(`查询积分失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("xhx-checkin", {
		description: "领取小浣熊每日积分",
		handler: async (_args, ctx) => {
			const token = await accessToken(ctx);
			if (!requireToken(ctx, token)) return;
			try {
				const grant = await claimDailyGrant(token);
				const detail = grant.popups.length > 0 ? `（${grant.popups.length} 条发放提示）` : "";
				ctx.ui.notify(`每日积分已触发${detail}`, "info");
			} catch (error) {
				ctx.ui.notify(`签到失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("xhx-models", {
		description: "列出小浣熊可用模型",
		handler: async (_args, ctx) => {
			const models = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID);
			if (models.length === 0) {
				ctx.ui.notify(`没有已注册的 ${PROVIDER_ID} 模型`, "warning");
				return;
			}
			const lines = models.map((model) => `${model.id}  —  ${model.name}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
