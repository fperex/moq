import { expect, test } from "bun:test";
import { threadVoid } from "./schema.ts";

test("audio fed by the page's worker over the lane's transport counts", () => {
	expect(threadVoid({ kind: "worker", transport: "webtransport" }, "webtransport")).toBeUndefined();
	expect(threadVoid({ kind: "worker", transport: "websocket" }, "websocket")).toBeUndefined();
});

test("audio the page played itself voids the row, with why", () => {
	expect(threadVoid({ kind: "main", reason: "the audio worker said nothing for 2 s" }, "webtransport")).toEqual({
		assertion: "thread",
		detail: "the audio played on the main thread: the audio worker said nothing for 2 s",
	});
	// Kept on the page with no reason: the build had no worker to offer, or the page turned it off.
	expect(threadVoid({ kind: "main" }, "webtransport")?.assertion).toBe("thread");
});

test("a worker whose own session ran over another transport voids the row", () => {
	// The page's session is checked on its own; the worker's is a second one it never sees.
	expect(threadVoid({ kind: "worker", transport: "websocket" }, "webtransport")).toEqual({
		assertion: "transport",
		detail: "the audio worker's session negotiated websocket",
	});
	expect(threadVoid({ kind: "worker" }, "webtransport")?.assertion).toBe("transport");
});

test("a worker that never started voids the row", () => {
	expect(threadVoid({ kind: "pending" }, "webtransport")?.assertion).toBe("thread");
});

test("a build that cannot say which thread fed the ring is not voided for it", () => {
	expect(threadVoid(undefined, "webtransport")).toBeUndefined();
	expect(threadVoid(undefined, "webtransport", "main")).toBeUndefined();
});

test("a row that keeps its audio on the page counts only the main thread it chose", () => {
	expect(threadVoid({ kind: "main" }, "webtransport", "main")).toBeUndefined();
	expect(threadVoid({ kind: "worker", transport: "webtransport" }, "webtransport", "main")).toEqual({
		assertion: "thread",
		detail: "the audio played on the worker, where the row keeps it on the main thread",
	});
	expect(threadVoid({ kind: "pending" }, "webtransport", "main")?.assertion).toBe("thread");
	// A reason is a fallback: the page tried the worker the row told it not to use.
	expect(threadVoid({ kind: "main", reason: "the worker failed to load" }, "webtransport", "main")).toEqual({
		assertion: "thread",
		detail: "the page fell back to the main thread rather than keeping the audio there: the worker failed to load",
	});
});
