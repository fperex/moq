import { expect, test } from "bun:test";
import { graded, QUIET, RATE, reference, samples, share, source } from "./silence.fixture.ts";
import { locate, prove } from "./silence.ts";

const film = source();

test("an exact rendering of authored quiet is proven window by window", () => {
	const all = samples(film);
	const window = graded(all);
	expect(share(window)).toBeGreaterThan(0.191);

	const proof = prove(all, window, reference(film));
	expect(proof.reason).toBeUndefined();
	expect(proof.proven).toBe(true);
	expect(proof.quiet).toBeGreaterThan(0);
	expect(proof.matched).toBe(proof.quiet);
	expect(proof.alignment?.correlation).toBeGreaterThan(0.9999);
	expect(proof.alignment?.gain).toBeCloseTo(1, 3);
	// The container offset the fit had to find, against the playhead's own media time.
	expect(proof.alignment?.shiftMs).toBeLessThan(-1000);
	for (const quiet of proof.quietWindows) {
		expect(quiet.source).toBeGreaterThanOrEqual(QUIET[0]);
		expect(quiet.source).toBeLessThan(QUIET[1]);
		expect(quiet.reference).toBeLessThan(0.001);
	}
});

test("one quiet window over audible source keeps the failure", () => {
	const all = samples(film);
	const window = graded(all);
	const gap = window.findIndex((s) => (s.rms ?? 0) > 0.01);
	window[gap].rms = 0.0002;

	const proof = prove(all, window, reference(film));
	expect(proof.proven).toBe(false);
	expect(proof.matched).toBe(proof.quiet - 1);
	const refused = proof.quietWindows.filter((q) => q.refused !== undefined);
	expect(refused.map((q) => [q.at, q.refused])).toEqual([[window[gap].at, "audible source"]]);
	expect(refused[0].reference).toBeGreaterThan(0.001);
	expect(proof.reason).toContain("audible source");
});

test("a row with no reference cannot be proven", () => {
	const all = samples(film);
	const proof = prove(all, graded(all), undefined);
	expect(proof.proven).toBe(false);
	expect(proof.reason).toContain("reference");
	expect(proof.matched).toBe(0);
});

test("a reference of a different film fails the alignment check", () => {
	const all = samples(film);
	const proof = prove(all, graded(all), reference(source(85, [4.1, 2.9])));
	expect(proof.proven).toBe(false);
	expect(proof.reason).toContain("alignment");
	expect(proof.matched).toBe(0);
});

test("a reference further from the playhead than the search fails the alignment check", () => {
	const all = samples(film);
	const proof = prove(all, graded(all), reference(film, -20 * RATE));
	expect(proof.proven).toBe(false);
	expect(proof.reason).toContain("alignment");
});

for (const [field, value, refused] of [
	["generation", 2, "graph"],
	["anchor", 1, "timeline"],
] as const) {
	test(`a quiet window with a new ${refused} inside it is refused`, () => {
		const all = samples(film);
		const window = graded(all);
		const quiet = window.find((s) => (s.rms ?? 1) < 0.001);
		if (!quiet?.playout) throw new Error("the fixture has no quiet window");
		quiet.playout = { ...quiet.playout, [field]: value };

		const proof = prove(all, window, reference(film));
		expect(proof.proven).toBe(false);
		expect(proof.quietWindows.find((q) => q.at === quiet.at)?.refused).toBe(refused);
	});
}

test("a quiet window without its context time is refused", () => {
	const all = samples(film);
	const window = graded(all);
	const quiet = window.find((s) => (s.rms ?? 1) < 0.001);
	if (!quiet) throw new Error("the fixture has no quiet window");
	quiet.contextTime = undefined;

	const proof = prove(all, window, reference(film));
	expect(proof.proven).toBe(false);
	expect(proof.quietWindows.find((q) => q.at === quiet.at)?.refused).toBe("timing");
});

test("a time stretch between reports moves the windows after it, and they still line up", () => {
	// An expansion in the middle of the quiet stretch, where the bracketed windows straddle it.
	const all = samples(film, { expandAt: 150 });
	const proof = prove(all, graded(all), reference(film));
	expect(proof.reason).toBeUndefined();
	expect(proof.proven).toBe(true);
	expect(proof.alignment?.correlation).toBeGreaterThan(0.9999);
});

test("a concealment between reports refuses the windows it could have touched", () => {
	const all = samples(film);
	const window = graded(all);
	const quiet = window.findIndex((s) => (s.rms ?? 1) < 0.001);
	const at = all.indexOf(window[quiet]);
	for (const s of all.slice(at)) if (s.playout) s.playout = { ...s.playout, concealed: 441 };

	const proof = prove(all, window, reference(film));
	expect(proof.proven).toBe(false);
	expect(proof.quietWindows.find((q) => q.at === window[quiet].at)?.refused).toBe("discontinuity");
});

test("the decoded span covers the search either side of the row's playheads", () => {
	const all = samples(film);
	const span = locate(graded(all));
	if ("reason" in span) throw new Error(span.reason);
	// The graded playheads run from 10.6 s to 75.4 s of media time; the search adds 5 s either side.
	expect(span.from).toBeLessThanOrEqual(10.6 - 5);
	expect(span.from + span.seconds).toBeGreaterThanOrEqual(75.4 + 5);

	// Twenty minutes into the publisher's stream, several passes of the looped file later.
	const later = locate(graded(all).map((s) => ({ ...s, timestamp: (s.timestamp ?? 0) + 1_200_000 })));
	if ("reason" in later) throw new Error(later.reason);
	expect(later.from).toBe(span.from + 1200);
	expect(later.seconds).toBe(span.seconds);

	expect(locate(graded(all).map((s) => ({ ...s, timestamp: undefined })))).toEqual({
		reason: "no window has a playhead",
	});
});

test("a quiet final window, with no later report to bracket it, is still placed", () => {
	// The row ends forty seconds in, inside the authored quiet stretch.
	const all = samples(film, { count: 160 });
	const window = graded(all);
	expect(window.at(-1)?.rms).toBeLessThan(0.001);

	const proof = prove(all, window, reference(film));
	expect(proof.reason).toBeUndefined();
	expect(proof.quietWindows.at(-1)).toMatchObject({ at: window.at(-1)?.at, reference: expect.any(Number) });
	expect(proof.quietWindows.at(-1)?.refused).toBeUndefined();
});

test("repeated stretches between reports widen the bracket instead of refusing it", () => {
	const all = samples(film, { expandAt: 150 });
	for (const s of all.slice(150)) if (s.playout) s.playout = { ...s.playout, expands: 3 };
	const proof = prove(all, graded(all), reference(film));
	expect(proof.reason).toBeUndefined();
	expect(proof.proven).toBe(true);
});

test("a torn shared-ring read, an offset step with no stretch, is bracketed rather than learned from", () => {
	const all = samples(film);
	const window = graded(all);
	// A quantum rendered between the poll's playhead and counter reads: `output` one quantum ahead.
	const quiet = window.find((s) => (s.rms ?? 1) < 0.001);
	const loud = window.find((s) => (s.rms ?? 0) > 0.01);
	for (const torn of [quiet, loud])
		if (torn?.playout) torn.playout = { ...torn.playout, output: torn.playout.output + 128 };

	const proof = prove(all, window, reference(film));
	expect(proof.reason).toBeUndefined();
	expect(proof.proven).toBe(true);
	expect(proof.alignment?.correlation).toBeGreaterThan(0.9999);
});
