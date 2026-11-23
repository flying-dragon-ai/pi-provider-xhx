import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 20_000,
		hookTimeout: 20_000,
		// The request throttle is on by default; tests do not need it.
		env: { XHX_MIN_INTERVAL_MS: "0" },
	},
});
