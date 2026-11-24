/**
 * A stand-in for the 小浣熊 gateway.
 *
 * It implements the endpoints the extension touches, with the response
 * shapes the Go proxy documents: the `{code,message,data}` envelope, the
 * `categories[].models[]` catalog, and non-streaming OpenAI completions with reasoning, tool calls, and usage.
 *
 * Every request is recorded so tests can assert on the exact wire payload.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
	method: string;
	path: string;
	receivedAt: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

export interface MockOptions {
	/** Rotate the refresh token on `/refresh`. */
	rotateRefreshToken?: boolean;
	/** Catalog payload override. */
	catalog?: unknown;
	/** Access token lifetime in seconds. */
	tokenTtlSeconds?: number;
	/** Shape of the chat stream: normal, empty, malformed, unicode, or truncate. */
	chatMode?: "normal" | "empty" | "malformed" | "unicode" | "truncate" | "blocked";
	/** Return this body instead of the normal successful completion. */
	chatResponse?: unknown;
	/** Delay a successful or overridden completion response. */
	chatDelayMs?: number;
	/** Fixed port for manual end-to-end runs; 0 picks a free one. */
	port?: number;
}

export interface MockUpstream {
	origin: string;
	requests: RecordedRequest[];
	close(): Promise<void>;
	/** Access token the mock currently considers valid. */
	validAccessToken(): string;
}

function base64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

export function makeJwt(payload: Record<string, unknown>): string {
	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = base64url(JSON.stringify(payload));
	return `${header}.${body}.signature`;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

const DEFAULT_CATALOG = {
	code: 0,
	data: {
		categories: [
			{
				type: "chat",
				models: [
					{
						name: "sn-glm-5-3-flash",
						description: "glm-5.3-flash",
						display_description: "GLM-5.3 Flash",
						tags: ["fast"],
						context_window: 131072,
						max_tokens: 8192,
						params: {
							raccoon_thinking: {
								managed: true,
								supported: true,
								can_disable: false,
								default_level: "level_1",
								display_levels: [
									{ value: "level_1", label: "Minimal" },
									{ value: "level_3", label: "Medium" },
									{ value: "level_5", label: "Max" },
								],
							},
						},
					},
					{
						name: "sn-kimi-k3",
						description: "kimi-k3",
						display_description: "Kimi K3",
						params: { context_window: 262144, max_tokens: 16384 },
					},
					{ name: "sn-glm-5-3-flash", description: "duplicate", display_description: "Duplicate" },
					{ name: "", description: "nameless" },
					{ name: "raccoon-internal", description: "internal", visible: false },
				],
			},
		],
	},
};


export async function startMockUpstream(options: MockOptions = {}): Promise<MockUpstream> {
	const requests: RecordedRequest[] = [];
	const ttl = options.tokenTtlSeconds ?? 3600;
	let accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + ttl, user_id: "7591340" });
	let refreshToken = "rt-initial";
	let refreshCount = 0;

	const server: Server = createServer((req, res) => {
		void (async () => {
			const body = await readBody(req);
			const path = (req.url ?? "/").split("?")[0] ?? "/";
			requests.push({ method: req.method ?? "GET", path, receivedAt: Date.now(), headers: req.headers, body });

			const authorized = (req.headers.authorization ?? "") === `Bearer ${accessToken}`;

			if (path === "/api/web/auth/v1/login_with_authorization_code") {
				const parsed = JSON.parse(body || "{}") as { authorization_code?: string };
				const code = parsed.authorization_code ?? "";
				if (code === "expired-code") {
					sendJson(res, 200, { code: 200035, message: "授权码已失效" });
					return;
				}
				if (code === "bad-code") {
					sendJson(res, 400, { code: 100002, message: "params_invalid_error" });
					return;
				}
				accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + ttl, user_id: "7591340" });
				sendJson(res, 200, {
					code: 0,
					message: "ok",
					data: {
						access_token: accessToken,
						refresh_token: refreshToken,
						office_identity: "employee",
						office_org_name: "Acme",
						office_org_role: "member",
					},
				});
				return;
			}

			if (path === "/api/web/auth/v1/refresh") {
				const parsed = JSON.parse(body || "{}") as { refresh_token?: string };
				if (parsed.refresh_token !== refreshToken) {
					sendJson(res, 401, { code: 100002, message: "refresh token invalid" });
					return;
				}
				refreshCount += 1;
				accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + ttl, user_id: "7591340" });
				if (options.rotateRefreshToken) refreshToken = `rt-rotated-${refreshCount}`;
				sendJson(res, 200, {
					code: 0,
					data: { access_token: accessToken, refresh_token: options.rotateRefreshToken ? refreshToken : "" },
				});
				return;
			}

			if (path === "/api/web/llm/v2/model_catalog") {
				if (!authorized) {
					sendJson(res, 401, { code: 401, message: "unauthorized" });
					return;
				}
				sendJson(res, 200, options.catalog ?? DEFAULT_CATALOG);
				return;
			}

			if (path === "/api/web/points/v1/balance") {
				if (!authorized) {
					sendJson(res, 401, { code: 401, message: "unauthorized" });
					return;
				}
				sendJson(res, 200, {
					code: 0,
					data: { available_points: 1234, daily_points: 300, monthly_points: "9000", reward_points: 0 },
				});
				return;
			}

			if (path === "/api/web/auth/v1/entitlement_info") {
				if (!authorized) {
					sendJson(res, 401, { code: 401, message: "unauthorized" });
					return;
				}
				sendJson(res, 200, { code: 0, data: { plan: "free", seats: 1 } });
				return;
			}

			if (path === "/api/web/office/v3/setting_info") {
				if (!authorized) {
					sendJson(res, 401, { code: 401, message: "unauthorized" });
					return;
				}
				sendJson(res, 200, {
					code: 0,
					data: { point_grant_popups: [{ points: 300 }], point_grant_toast: { text: "+300" } },
				});
				return;
			}

			if (path === "/api/web/llm/v1/chat/completions") {
				if (!authorized) {
					sendJson(res, 401, { code: 401, message: "unauthorized" });
					return;
				}
				const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
				if (options.chatMode === "blocked") {
					sendJson(res, 429, {
						error: {
							code: 200108,
							message: "系统检测到当前账号存在异常调用，模型调用功能已暂时受限。",
							type: "rate_limit_error",
						},
					});
					return;
				}
				if (options.chatMode === "truncate") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.write('{"id":"chatcmpl-mock","choices":');
					res.destroy();
					return;
				}
				if (options.chatMode === "malformed") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end("{not json at all");
					return;
				}
				if (options.chatDelayMs !== undefined) {
					await new Promise((resolve) => setTimeout(resolve, options.chatDelayMs));
				}
				if (options.chatResponse !== undefined) {
					sendJson(res, 200, options.chatResponse);
					return;
				}

				const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
				const hasToolResult = messages.some((message) => (message as { role?: string }).role === "tool");
				const wantsTool =
					!hasToolResult && JSON.stringify(messages).includes("TOOLCALL") && Array.isArray(parsed.tools);
				const toolList = (parsed.tools ?? []) as { function?: { name?: string } }[];
				const toolName = wantsTool
					? (toolList.find((tool) => tool.function?.name === "read_file")?.function?.name ??
						toolList[0]?.function?.name ??
						"read_file")
					: "";

				const message: Record<string, unknown> = { role: "assistant", content: "" };
				let finish = "stop";
				if (wantsTool) {
					message.tool_calls = [
						{ id: "call_1", type: "function", function: { name: toolName, arguments: '{"path":"a.txt"}' } },
					];
					finish = "tool_calls";
				} else if (options.chatMode === "empty") {
					message.content = "";
				} else if (options.chatMode === "unicode") {
					message.content = "🙂 done";
				} else {
					message.reasoning_content = "先想一想";
					message.content = "你好，世界";
				}

				sendJson(res, 200, {
					id: "chatcmpl-mock",
					object: "chat.completion",
					model: "sn-glm-5-3-flash",
					choices: [{ index: 0, finish_reason: finish, message }],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 5,
						total_tokens: 15,
						completion_tokens_details: { reasoning_tokens: 2 },
					},
				});
				return;
			}

			sendJson(res, 404, { code: 404, message: `no route ${path}` });
		})().catch((error: unknown) => {
			if (!res.headersSent) sendJson(res, 500, { code: 500, message: String(error) });
			else res.end();
		});
	});

	await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	return {
		origin: `http://127.0.0.1:${address.port}`,
		requests,
		validAccessToken: () => accessToken,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections?.();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
