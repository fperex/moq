import { expect, test } from "bun:test";
import * as Catalog from "@moq/hang/catalog";
import { Time } from "@moq/net";
import { Effect, Signal } from "@moq/signals";
import { decoderConfig, playbackIdentity, playbackJitter } from "./config";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function config(fields: Record<string, unknown> = {}): Catalog.AudioConfig {
	return Catalog.AudioConfigSchema.parse({
		codec: "opus",
		container: { kind: "legacy" },
		sampleRate: 48000,
		numberOfChannels: 2,
		...fields,
	});
}

test("metadata and routing changes do not change the decoder config", async () => {
	const rendition = new Signal<Catalog.AudioConfig>(config());
	const root = new Effect();
	const decoder = root.computed((effect) => decoderConfig(effect.get(rendition)));
	let worklets = 0;

	root.run((effect) => {
		effect.get(decoder);
		worklets++;
	});
	await flush();
	expect(worklets).toBe(1);

	// A bitrate-only republish, the shape the MPEG-TS importer emits as it refines its estimate.
	rendition.set(config({ bitrate: 128_000 }));
	await flush();
	expect(worklets).toBe(1);

	rendition.set(config({ bitrate: 96_000, jitter: 20, timeline: { track: "timeline" } }));
	await flush();
	expect(worklets).toBe(1);

	rendition.set(config({ broadcast: "../source" }));
	await flush();
	expect(worklets).toBe(1);

	rendition.set(config({ sampleRate: 44100 }));
	await flush();
	expect(worklets).toBe(2);

	root.close();
});

test("routing and decoder inputs change the playback identity", () => {
	const base = playbackIdentity(config());

	expect(playbackIdentity(config({ broadcast: "../source" }))).not.toEqual(base);
	expect(playbackIdentity(config({ codec: "mp4a.40.2" }))).not.toEqual(base);
	expect(playbackIdentity(config({ container: { kind: "loc" } }))).not.toEqual(base);
	expect(playbackIdentity(config({ description: "4f707573486561640102" }))).not.toEqual(base);
	expect(playbackIdentity(config({ sampleRate: 44100 }))).not.toEqual(base);
	expect(playbackIdentity(config({ numberOfChannels: 1 }))).not.toEqual(base);
});

test("an advertised jitter of zero falls back to the codec frame duration", () => {
	// 48kHz Opus reads as its 20ms frame, not 23ms: the worklet's render quantum is the ring's
	// granularity, not the publisher's, so it is no longer folded in here.
	const floor = playbackJitter(config());
	expect(floor).toBe(Time.Milli(20));
	expect(playbackJitter(config({ jitter: 0 }))).toBe(floor);
	expect(playbackJitter(config({ jitter: 60 }))).toBe(Time.Milli(60));
});

test("AAC and MP3 jitter follows their codec frame sizes", () => {
	expect(playbackJitter(config({ codec: "mp4a.40.2", sampleRate: 48000 }))).toBe(Time.Milli(22));
	expect(playbackJitter(config({ codec: "mp4a.40.2", sampleRate: 24000 }))).toBe(Time.Milli(43));
	expect(playbackJitter(config({ codec: "mp3", sampleRate: 48000 }))).toBe(Time.Milli(24));
	expect(playbackJitter(config({ codec: "mp3", sampleRate: 24000 }))).toBe(Time.Milli(24));
});

test("an unknown codec with no advertised jitter reserves nothing", () => {
	// Nothing is known about its frame duration, so the estimator is the only term. The ring's own
	// slack covers the render quantum either way.
	expect(playbackJitter(config({ codec: "flac", jitter: 0 }))).toBe(Time.Milli(0));
});
