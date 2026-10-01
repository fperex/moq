/**
 * Signals and measurements the playout tests share, mirroring `rs/moq-audio/src/playout/fixture.rs`
 * so a failure in one language reproduces in the other.
 *
 * Everything here is deterministic: the noise source is a fixed LCG, so a failure reproduces exactly.
 *
 * @internal Test support, not part of the engine.
 */

import { type Counters, frames, type RingReader, type RingView, STRETCH_BOUND } from "./index";

const TAU = Math.PI * 2;

/** Planar samples of a sine, every channel in phase. */
export function tone(
	rate: number,
	seconds: number,
	frequency: number,
	amplitude: number,
	channels = 1,
): Float32Array[] {
	const total = Math.floor(rate * seconds);
	const step = (TAU * frequency) / rate;
	const mono = new Float32Array(total);
	for (let i = 0; i < total; i++) mono[i] = amplitude * Math.sin(step * i);
	return Array.from({ length: channels }, () => mono.slice());
}

/** Planar stereo where the right channel is the left one inverted. */
export function antiphase(rate: number, seconds: number, frequency: number, amplitude: number): Float32Array[] {
	const [left] = tone(rate, seconds, frequency, amplitude, 1);
	const right = new Float32Array(left.length);
	for (let i = 0; i < left.length; i++) right[i] = -left[i];
	return [left, right];
}

/** Planar white noise in `-amplitude..amplitude`, the same in every channel. */
export function noise(rate: number, seconds: number, amplitude: number, channels = 1): Float32Array[] {
	const total = Math.floor(rate * seconds);
	const mono = new Float32Array(total);
	let state = 0x1234_5678_9abc_def0n;
	for (let i = 0; i < total; i++) {
		state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffff_ffff_ffff_ffffn;
		const uniform = Number(state >> 40n) / 2 ** 23 - 1;
		mono[i] = uniform * amplitude;
	}
	return Array.from({ length: channels }, () => mono.slice());
}

/**
 * A tone that pauses, over a noise floor: the shape a background estimate can learn from.
 *
 * A pure sine never trains {@link Noise}, because no window of it is ever quiet, so concealment
 * built on one fades into digital silence rather than into the room. Real speech pauses, and the
 * pauses are where the room is measured, so anything testing concealment over more than a few
 * blocks wants this rather than {@link tone}.
 */
export function speech(
	rate: number,
	seconds: number,
	frequency: number,
	amplitude: number,
	floor: number,
	channels = 1,
): Float32Array[] {
	const [voiced] = tone(rate, seconds, frequency, amplitude, 1);
	const [room] = noise(rate, seconds, floor, 1);
	const cycle = Math.round(rate * 1.0);
	const pause = Math.round(rate * 0.2);

	const mono = new Float32Array(voiced.length);
	for (let i = 0; i < mono.length; i++) {
		mono[i] = room[i] + (i % cycle < cycle - pause ? voiced[i] : 0);
	}
	return Array.from({ length: channels }, () => mono.slice());
}

/** A signal with a short period plus enough noise to spoil its correlation. */
export function buzz(
	rate: number,
	seconds: number,
	periodMs: number,
	amplitude: number,
	jitter: number,
): Float32Array[] {
	const total = Math.floor(rate * seconds);
	const [shape] = noise(rate, periodMs / 1000, amplitude, 1);
	const [dither] = noise(rate, seconds, jitter, 1);
	const out = new Float32Array(total);
	for (let i = 0; i < total; i++) out[i] = shape[i % shape.length] + dither[i];
	return [out];
}

/** Mean per sample energy of the first `length` frames. */
export function energy(pcm: Float32Array, length = pcm.length): number {
	let sum = 0;
	for (let i = 0; i < length; i++) sum += pcm[i] * pcm[i];
	return sum / Math.max(1, length);
}

/** Goertzel magnitude of `frequency` in `pcm`, normalised by length. */
export function goertzel(pcm: Float32Array, rate: number, frequency: number): number {
	const coefficient = 2 * Math.cos((TAU * frequency) / rate);
	let first = 0;
	let second = 0;
	for (const sample of pcm) {
		const next = sample + coefficient * first - second;
		second = first;
		first = next;
	}
	const power = first * first + second * second - coefficient * first * second;
	return Math.sqrt(Math.max(0, power)) / pcm.length;
}

/** The strongest frequency in `low..high`, to 0.5Hz. */
export function dominant(pcm: Float32Array, rate: number, low: number, high: number): number {
	let best = low;
	let magnitude = Number.NEGATIVE_INFINITY;
	for (let frequency = low; frequency <= high; frequency += 0.5) {
		const found = goertzel(pcm, rate, frequency);
		if (found > magnitude) {
			magnitude = found;
			best = frequency;
		}
	}
	return best;
}

/** The largest jump between consecutive samples. */
export function maxStep(pcm: Float32Array): number {
	let largest = 0;
	for (let i = 1; i < pcm.length; i++) largest = Math.max(largest, Math.abs(pcm[i] - pcm[i - 1]));
	return largest;
}

/** The longest run of samples that are exactly zero. */
export function zeroRun(pcm: Float32Array): number {
	let longest = 0;
	let run = 0;
	for (const sample of pcm) {
		run = sample === 0 ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}

/**
 * A mono ring that always reports `depthMs` against a 100ms target, so the decision the engine takes
 * is the caller's to choose. Empty for `outage` blocks out of every `cycle` when those are set, which
 * forces a concealment run and the merge that ends it over and over.
 */
export class FixedRing implements RingReader {
	readonly channels = 1;
	readonly rate: number;
	readonly #source: Float32Array;
	readonly #depth: number;
	readonly #outage: number;
	readonly #cycle: number;
	#at = 0;
	// Blocks the engine has asked for, which the outage is counted in: it looks once per block.
	#asked = 0;

	constructor(rate: number, source: Float32Array, depthMs: number, outage = 0, cycle = 0) {
		this.rate = rate;
		this.#source = source;
		this.#depth = frames(rate, depthMs);
		this.#outage = outage;
		this.#cycle = cycle;
	}

	view(): RingView {
		const dry = this.#cycle > 0 && this.#asked % this.#cycle < this.#outage;
		this.#asked++;

		return {
			buffered: dry ? 0 : this.#depth,
			target: frames(this.rate, 100),
			chunk: frames(this.rate, 20),
			skip: frames(this.rate, STRETCH_BOUND),
			stalled: false,
			ended: false,
			unstable: false,
			converge: true,
			skipped: 0,
			generation: 1,
		};
	}

	peek(dst: Float32Array[], count: number, offset = 0): void {
		const start = this.#at % (this.#source.length - count);
		dst[0].set(this.#source.subarray(start, start + count), offset);
	}

	commit(count: number): boolean {
		this.#at += count;
		return true;
	}

	starve(): void {}

	report(_counters: Counters): void {}
}
