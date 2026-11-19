/**
 * Account endpoints that are not part of the chat protocol: points balance,
 * subscription entitlement, and the daily grant trigger.
 *
 * These are the same calls the Go proxy makes for its admin panel and its
 * check-in task. They are exposed here as slash commands so the operator can
 * see the account state without leaving pi.
 */

import { authBase, pointsBase, resolveOrigin } from "./constants.ts";

export interface Balance {
	available?: number;
	daily?: number;
	monthly?: number;
	reward?: number;
	topup?: number;
}

interface Envelope {
	code?: number;
	message?: string;
	msg?: string;
	data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

async function request(url: string, accessToken: string, headers: Record<string, string> = {}): Promise<Envelope> {
	const response = await fetch(url, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}`, ...headers },
	});
	const raw = await response.text();
	let body: Envelope = {};
	try {
		body = asRecord(JSON.parse(raw)) as Envelope;
	} catch {
		body = {};
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${body.message ?? body.msg ?? raw.slice(0, 160)}`);
	}
	if (typeof body.code === "number" && body.code !== 0) {
		throw new Error(`code=${body.code} ${body.message ?? body.msg ?? ""}`.trim());
	}
	return body;
}

/** `GET {points_base}/balance` */
export async function fetchBalance(accessToken: string): Promise<Balance> {
	const body = await request(`${pointsBase()}/balance`, accessToken);
	const data = asRecord(body.data);
	const balance: Balance = {};
	const available = asNumber(data.available_points);
	const daily = asNumber(data.daily_points);
	const monthly = asNumber(data.monthly_points);
	const reward = asNumber(data.reward_points);
	const topup = asNumber(data.topup_points);
	if (available !== undefined) balance.available = available;
	if (daily !== undefined) balance.daily = daily;
	if (monthly !== undefined) balance.monthly = monthly;
	if (reward !== undefined) balance.reward = reward;
	if (topup !== undefined) balance.topup = topup;
	return balance;
}

/** `GET {auth_base}/entitlement_info` — raw `data` node. */
export async function fetchEntitlement(accessToken: string): Promise<unknown> {
	const body = await request(`${authBase()}/entitlement_info`, accessToken);
	return body.data;
}

export interface DailyGrant {
	popups: unknown[];
	toast: unknown;
}

/**
 * `GET {origin}/api/web/office/v3/setting_info` — triggers the daily points
 * grant. The upstream grants at most once per day; calling it again is a no-op
 * that still answers `code: 0`.
 */
export async function claimDailyGrant(accessToken: string): Promise<DailyGrant> {
	const body = await request(`${resolveOrigin()}/api/web/office/v3/setting_info`, accessToken, {
		"X-Client-Platform": "desktop-windows",
		"X-Client-Version": "v1.0.0",
		"X-Raccoon-Language": "zh",
	});
	const data = asRecord(body.data);
	return {
		popups: Array.isArray(data.point_grant_popups) ? data.point_grant_popups : [],
		toast: data.point_grant_toast ?? null,
	};
}
