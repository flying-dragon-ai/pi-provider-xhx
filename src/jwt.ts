/**
 * Unsigned JWT reads. The upstream issues HS/RS tokens we never verify — we
 * only need `exp` (to schedule a refresh) and the user id (for display).
 */

function decodePayload(token: string): Record<string, unknown> | undefined {
	const cleaned = token.trim().replace(/^Bearer\s+/i, "");
	const parts = cleaned.split(".");
	if (parts.length < 2) return undefined;
	const segment = parts[1];
	if (!segment) return undefined;
	let json: string;
	try {
		json = Buffer.from(segment, "base64url").toString("utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(json);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** `exp` in epoch milliseconds, or 0 when the token carries no usable `exp`. */
export function jwtExpiry(token: string): number {
	const payload = decodePayload(token);
	if (!payload) return 0;
	const exp = payload.exp;
	const seconds = typeof exp === "number" ? exp : typeof exp === "string" ? Number(exp) : Number.NaN;
	if (!Number.isFinite(seconds) || seconds <= 0) return 0;
	return Math.trunc(seconds * 1000);
}

/** User id from `user_id` / `userId` / `uid` / `userID`, or "" when absent. */
export function jwtUserId(token: string): string {
	const payload = decodePayload(token);
	if (!payload) return "";
	// The IAM token carries the account id in `sub`; older shapes used user_id/uid.
	for (const key of ["sub", "user_id", "userId", "uid", "userID"]) {
		const value = payload[key];
		if (typeof value === "string" && value !== "") return value;
		if (typeof value === "number" && value !== 0) return String(value);
	}
	return "";
}

/** Last four characters of a token, for logs and status output. */
export function tokenTail(token: string): string {
	const chars = [...token];
	return chars.length <= 4 ? token : chars.slice(-4).join("");
}
