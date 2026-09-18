import { expect, test } from "bun:test";
import * as Container from "@moq/hang/container";
import { Group, Time, Track, Varint } from "@moq/net";
import { type DecodedSpan, Terminal } from "./terminal";

test("Terminal trims a partial packet to the source endpoint", () => {
	const terminal = new Terminal();
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro }, end: 17_916 as Time.Micro });
	expect(terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 }).frames).toBe(860);
});

test("Terminal maps Opus delay back before trimming terminal output", () => {
	const terminal = new Terminal();
	terminal.clear(312);
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro } });
	const body = terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 });
	expect(body).toEqual({ timestamp: 0 as Time.Micro, frameOffset: 312, frames: 648 });

	terminal.update({ discontinuity: 0, end: 20_000 as Time.Micro });
	terminal.update({ discontinuity: 0, frame: { timestamp: 20_000 as Time.Micro } });
	const drain = terminal.span({ timestamp: 20_000, sampleRate: 48_000, numberOfFrames: 960 });
	expect(drain).toEqual({ timestamp: 13_500 as Time.Micro, frameOffset: 0, frames: 312 });
	expect(body.frames + drain.frames).toBe(960);
});

test("Terminal preserves samples before the source endpoint", () => {
	const terminal = new Terminal();
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro }, end: 20_000 as Time.Micro });
	expect(terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 }).frames).toBe(960);
});

test("a rewound endpoint survives the discontinuity reset and trims its terminal packet", () => {
	const terminal = new Terminal();
	terminal.clear(312);
	terminal.update({ discontinuity: 0, end: 40_000 as Time.Micro });

	const reset = terminal.update({ discontinuity: 1, end: 20_000 as Time.Micro });
	expect(reset).toBe(true);
	expect(terminal.end).toBe(20_000 as Time.Micro);

	terminal.update({ discontinuity: 1, frame: { timestamp: 20_000 as Time.Micro } });
	const span = terminal.span({ timestamp: 20_000, sampleRate: 48_000, numberOfFrames: 960 });
	expect(span).toEqual({ timestamp: 20_000 as Time.Micro, frameOffset: 312, frames: 0 });
});

test("Terminal reports a hole in the source the decoder would swallow", () => {
	const terminal = new Terminal();
	terminal.clear();

	// Nothing to measure against until a frame has decoded and named the frame duration.
	expect(terminal.continues(0 as Time.Micro)).toBe(true);
	terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 });

	// The normal cadence, including the rounding a container's integer timestamps carry.
	expect(terminal.continues(20_000 as Time.Micro)).toBe(true);
	expect(terminal.continues(40_001 as Time.Micro)).toBe(true);
	expect(terminal.continues(59_999 as Time.Micro)).toBe(true);

	// One frame missing is already a hole: a decoder told nothing about it keeps timestamping its
	// output on the old run, so every sample after it lands 20ms in the past.
	expect(terminal.continues(100_000 as Time.Micro)).toBe(false);

	// The frame that opens the new run continues it.
	terminal.reanchor();
	expect(terminal.continues(120_000 as Time.Micro)).toBe(true);
});

test("Terminal starts a fresh run at a codec epoch rather than measuring across the break", () => {
	const terminal = new Terminal();
	terminal.clear();
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro } });
	expect(terminal.continues(0 as Time.Micro)).toBe(true);
	terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 });

	// The caller already resets the decoder on an epoch change, so the first frame of the new epoch
	// must not ask for a second one however far it sits from the last frame of the old.
	expect(terminal.update({ discontinuity: 1, frame: { timestamp: 9_000_000 as Time.Micro } })).toBe(true);
	expect(terminal.continues(9_000_000 as Time.Micro)).toBe(true);
});

test("Terminal re-anchors on the frame after the hole rather than one later", () => {
	const terminal = new Terminal();
	terminal.clear();
	terminal.continues(0 as Time.Micro);
	terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 });

	expect(terminal.continues(3_000_000 as Time.Micro)).toBe(false);
	terminal.reanchor();
	// The re-anchored run still knows where it started, so a second hole right behind the first is
	// reported too.
	expect(terminal.continues(6_000_000 as Time.Micro)).toBe(false);
});

test("a declared break reopens a timeline that ended", () => {
	// A muted publisher declares where its timeline stops, and declares a break when it resumes:
	// an endpoint trims everything past it, so without the break the watcher would never hear the
	// talker again.
	const terminal = new Terminal();
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro }, end: 20_000 as Time.Micro });
	expect(terminal.end).toBe(20_000 as Time.Micro);

	expect(terminal.update({ discontinuity: 1, frame: { timestamp: 10_020_000 as Time.Micro } })).toBe(true);
	expect(terminal.end).toBeUndefined();
	expect(terminal.span({ timestamp: 10_020_000, sampleRate: 48_000, numberOfFrames: 960 }).frames).toBe(960);
});

test("a discontinuity reapplies Opus pre-skip in the resumed epoch", () => {
	const terminal = new Terminal();
	terminal.clear(312);
	terminal.update({ discontinuity: 0, frame: { timestamp: 0 as Time.Micro } });
	expect(terminal.span({ timestamp: 0, sampleRate: 48_000, numberOfFrames: 960 }).frameOffset).toBe(312);

	terminal.update({ discontinuity: 1, frame: { timestamp: 1_000_000 as Time.Micro } });
	const resumed = terminal.span({ timestamp: 1_000_000, sampleRate: 48_000, numberOfFrames: 960 });
	expect(resumed).toEqual({ timestamp: 1_000_000 as Time.Micro, frameOffset: 312, frames: 648 });
});

test("an endpoint delivered before its playhead event trims the flush and not the resumed run", async () => {
	// Ordered by the real consumer, because the order is the whole point: the endpoint belongs to
	// the run it ends and the playhead event to the result that closes the marker group. Delivered
	// as one result instead, the event resets the endpoint and the same result re-applies it, so
	// every sample of the resumed run is trimmed to nothing and the talker is never heard again.
	const track = new Track.Producer("audio");
	const consumer = new Container.Consumer(track.subscribe({ maxAge: 30_000 }), {
		// Wide enough that the ten second pause is not a conviction: the publisher declared it.
		format: new Container.Legacy.Format("audio"),
		maxAge: 30_000 as Time.Milli,
	});

	const media = (sequence: number, timestamp: Time.Micro, payload: Uint8Array) => {
		const group = new Group.Producer(sequence);
		const ts = Varint.encode(timestamp);
		const frame = new Uint8Array(ts.byteLength + payload.byteLength);
		frame.set(ts, 0);
		frame.set(payload, ts.byteLength);
		group.writeFrame({ payload: frame, timestamp: Time.Timestamp.fromMicros(timestamp) });
		group.close();
		track.writeGroup(group);
	};

	const terminal = new Terminal();
	terminal.clear(312);

	media(0, 0 as Time.Micro, new Uint8Array([0xde, 0xad]));
	media(1, 20_000 as Time.Micro, new Uint8Array()); // the endpoint, alone in its group
	media(2, 10_020_000 as Time.Micro, new Uint8Array([0xde, 0xad]));
	track.close();

	const spans: DecodedSpan[] = [];
	for (;;) {
		const next = await consumer.next();
		if (!next) break;
		terminal.update(next);
		if (!next.frame) continue;
		// One decoded packet per container frame, which is what an Opus decoder hands back.
		spans.push(terminal.span({ timestamp: next.frame.timestamp, sampleRate: 48_000, numberOfFrames: 960 }));
	}

	// The first run, less the pre-skip, then its drain trimmed to the endpoint, then the resumed
	// run whole: the endpoint the publisher declared bounds its own run and nothing after it.
	expect(spans.map((span) => span.frames)).toEqual([648, 648]);
	expect(terminal.end).toBeUndefined();
	expect(consumer.skipped.peek()).toBe(0);

	consumer.close();
});
