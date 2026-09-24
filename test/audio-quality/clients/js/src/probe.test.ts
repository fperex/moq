import { expect, test } from "bun:test";
import type MoqWatch from "@moq/watch/element";
import { threadOf } from "./probe.ts";

// Only what `threadOf` reads: `audio.out`, with or without the signal.
const watch = (out: Record<string, unknown>) => ({ audio: { out } }) as unknown as MoqWatch;
const signal = (value: unknown) => ({ peek: () => value });

test("a build with the signal says which thread feeds the ring", () => {
	expect(threadOf(watch({ thread: signal({ kind: "worker", transport: "webtransport" }) }))).toEqual({
		kind: "worker",
		transport: "webtransport",
	});
	expect(threadOf(watch({ thread: signal({ kind: "main", reason: "refused" }) }))).toEqual({
		kind: "main",
		reason: "refused",
	});
});

test("a worker still starting is pending, not a build that cannot say", () => {
	expect(threadOf(watch({ thread: signal(undefined) }))).toEqual({ kind: "pending" });
	expect(threadOf(watch({}))).toBeUndefined();
});
