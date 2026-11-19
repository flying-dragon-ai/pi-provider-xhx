/**
 * Manual end-to-end harness: serve the mock gateway on a fixed port and print
 * the origin plus a valid access token, so a real `pi` process can be pointed
 * at it with `XHX_ORIGIN` / `XHX_ACCESS_TOKEN`.
 *
 *   node test/manual/serve-mock.ts 18080
 */

import { startMockUpstream } from "../mock-upstream.ts";

const port = Number(process.argv[2] ?? 18080);
const mock = await startMockUpstream({ port, frameDelayMs: 5 });
let seen = 0;
setInterval(() => {
	for (; seen < mock.requests.length; seen += 1) {
		const request = mock.requests[seen];
		process.stderr.write(`[mock] ${request?.method} ${request?.path}\n`);
	}
}, 100).unref();

process.stdout.write(
	`${JSON.stringify({ origin: mock.origin, token: mock.validAccessToken() })}\n`,
);

process.on("SIGTERM", () => {
	void mock.close().then(() => process.exit(0));
});
process.on("SIGINT", () => {
	void mock.close().then(() => process.exit(0));
});
