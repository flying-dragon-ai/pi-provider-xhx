/**
 * SSE sanitizer.
 *
 * The gateway is a proxy in front of several vendors' models. A single
 * unparseable `data:` frame — a keep-alive comment, a truncated write, a
 * vendor-specific line — makes the OpenAI SDK's SSE parser throw and kills an
 * otherwise healthy answer. The Go proxy this extension replaces passes such
 * lines through untouched; here the frame is dropped instead, so one bad frame
 * costs one frame rather than the whole response.
 *
 * Only `data:` lines are inspected. Comments, `event:`, `id:`, and blank lines
 * pass through unchanged.
 */

const DATA_PREFIX = "data:";

function sanitizeLine(line: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith(DATA_PREFIX)) return line;
	const payload = trimmed.slice(DATA_PREFIX.length).trim();
	if (payload === "" || payload === "[DONE]") return line;
	try {
		JSON.parse(payload);
		return line;
	} catch {
		return undefined;
	}
}

export function createSseSanitizer(): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";

	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline + 1);
				buffer = buffer.slice(newline + 1);
				const kept = sanitizeLine(line);
				if (kept !== undefined) controller.enqueue(encoder.encode(kept));
				newline = buffer.indexOf("\n");
			}
		},
		flush(controller) {
			buffer += decoder.decode();
			if (buffer.length === 0) return;
			const kept = sanitizeLine(buffer);
			if (kept !== undefined) controller.enqueue(encoder.encode(kept));
		},
	});
}

/** Wrap fetch so event-stream responses get their frames sanitized. */
export function withSseSanitizer(inner: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input, init) => {
		const response = await inner(input, init);
		const contentType = response.headers.get("content-type") ?? "";
		if (!response.body || !contentType.includes("text/event-stream")) return response;

		const headers = new Headers(response.headers);
		headers.delete("content-encoding");
		headers.delete("content-length");

		return new Response(response.body.pipeThrough(createSseSanitizer()), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}
