/** Parameters for the experimental PCM playout engine. */
export interface Config {
	rate: number;
	channels: number;
	target:
		| { kind: "fixed"; milliseconds: number }
		| { kind: "auto"; initialMilliseconds?: number; minMilliseconds?: number; maxMilliseconds?: number };
	buffered?: boolean;
	capacityMilliseconds?: number;
}

/** Per-channel sample accounting; auto measures PCM availability, not network arrival. */
export interface Stats {
	consumed: number;
	expanded: number;
	accelerated: number;
	concealed: number;
	silent: number;
	late: number;
	queueSamples: number;
	targetMilliseconds: number;
}

function limits(target: Config["target"]) {
	const initial = target.kind === "fixed" ? target.milliseconds : (target.initialMilliseconds ?? 80);
	if (!Number.isFinite(initial) || initial < 0) throw new RangeError("invalid target delay");
	const minimum = target.kind === "fixed" ? initial : (target.minMilliseconds ?? 20);
	const maximum = target.kind === "fixed" ? initial : (target.maxMilliseconds ?? 1000);
	if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum) {
		throw new RangeError("invalid auto delay limits");
	}
	return { initial, minimum, maximum };
}

function capacity(rate: number, maximum: number, configured?: number): number {
	const milliseconds = configured ?? Math.max(2000, maximum * 2);
	const samples = Math.ceil((milliseconds * rate) / 1000);
	if (
		!Number.isFinite(milliseconds) ||
		milliseconds < Math.max(100, maximum) ||
		!Number.isSafeInteger(samples) ||
		samples > 2 ** 30
	) {
		throw new RangeError("invalid PCM capacity");
	}
	return samples;
}

interface Pending {
	start: number;
	offset: number;
	planes: Float32Array[];
}

interface Concealment {
	output: Float32Array[];
	periodic: Float32Array[];
	residual: Float32Array[];
	ar: Float64Array;
	state: Float64Array;
	period: number;
	residualLength: number;
	voice: number;
	generated: number;
	seed: number;
}

const pcmScale = 32768 ** 2;
// NetEQ's Q15 background defaults, normalized to floating-point PCM.
const initialBackgroundEnergy = 2500 / pcmScale;
const initialBackgroundThreshold = 500000 / pcmScale;
const initialPassiveEnergy = 75000 / pcmScale;

function voiceMix(correlation: number): number {
	if (correlation <= 0.48) return 0;
	// NetEQ's voiced/unvoiced curve, evaluated without fixed-point rounding.
	const squared = correlation * correlation;
	const mixed = (-5179 + 19931 * correlation - 16422 * squared + 5776 * squared * correlation) / 4096;
	return Math.max(0, Math.min(1, mixed));
}

function endOf(span: Pending): number {
	return span.start + span.planes[0].length - span.offset;
}

/** A single-owner PCM experiment with bounded overlap-add and fading concealment. */
export class Playout {
	#config: Config;
	#capacity: number;
	#pcm: Float32Array[];
	#valid: Uint8Array;
	#pending: Array<Pending | undefined> = [];
	#pendingHead = 0;
	#held = 0;
	#contiguous = 0;
	readonly #block: Float32Array[];
	readonly #history: Float32Array[];
	readonly #concealSize: number;
	readonly #blockSize: number;
	readonly #overlap: number;
	readonly #maxLag: number;
	readonly #minLag: number;
	readonly #historySize: number;
	#read: number | undefined;
	#write = 0;
	#media: number | undefined;
	#endpoint: number | undefined;
	#playing = false;
	#blockOffset = 0;
	#blockLength = 0;
	#blockStart = 0;
	#blockConsumed = 0;
	#blockKind: "real" | "concealed" | "silent" = "silent";
	#historyCount = 0;
	#loss = 0;
	readonly #concealment: Concealment;
	#concealReady = false;
	#merge = 0;
	#mergePosition = 0;
	#lastOutputFrame: number | undefined;
	#nextScaleFrame = 0;
	#level: number | undefined;
	#target: number;
	#limits: ReturnType<typeof limits>;
	#estimate: number;
	#duration = 0;
	#arrivals: Array<{ arrived: number; delay: number }> = [];
	#arrivalHead = 0;
	#newestArrivalTimestamp = -Infinity;
	#intervalStart: number | undefined;
	#intervalMaximum = 0;
	readonly #histogram = new Float64Array(100);
	#backgroundEnergy = initialBackgroundEnergy;
	#backgroundThreshold = initialBackgroundThreshold;
	#backgroundMaximum = 0;
	#backgroundReady = false;
	readonly #totals = { consumed: 0, expanded: 0, accelerated: 0, concealed: 0, silent: 0, late: 0 };

	constructor(config: Config) {
		if (!Number.isInteger(config.rate) || config.rate < 8000 || config.rate > 192000) {
			throw new RangeError("unsupported PCM sample rate");
		}
		if (!Number.isInteger(config.channels) || config.channels < 1 || config.channels > 8) {
			throw new RangeError("unsupported PCM channel count");
		}
		this.#config = { ...config, target: { ...config.target } };
		this.#limits = limits(config.target);
		this.#estimate = this.#limits.initial;
		this.#target = Math.max(this.#limits.minimum, Math.min(this.#limits.maximum, this.#estimate));
		this.#capacity = capacity(config.rate, this.#limits.maximum, config.capacityMilliseconds);
		this.#blockSize = Math.round(config.rate * 0.02);
		this.#overlap = Math.round(config.rate * 0.005);
		this.#minLag = Math.round(config.rate * 0.0025);
		this.#maxLag = Math.round(config.rate * 0.01);
		this.#historySize = this.#maxLag * 4;
		this.#pcm = Array.from({ length: config.channels }, () => new Float32Array(this.#capacity));
		this.#valid = new Uint8Array(this.#capacity);
		this.#block = Array.from({ length: config.channels }, () => new Float32Array(this.#blockSize));
		this.#history = Array.from({ length: config.channels }, () => new Float32Array(this.#historySize));
		this.#concealSize = Math.round(config.rate * 0.06);
		this.#concealment = {
			output: Array.from({ length: config.channels }, () => new Float32Array(this.#concealSize)),
			periodic: Array.from({ length: config.channels }, () => new Float32Array(this.#maxLag)),
			residual: Array.from({ length: config.channels }, () => new Float32Array(this.#historySize)),
			ar: new Float64Array(config.channels),
			state: new Float64Array(config.channels),
			period: 0,
			residualLength: 0,
			voice: 0,
			generated: 0,
			seed: 1,
		};
	}

	/** Update delay policy without discarding queued media. */
	configure(policy: Pick<Config, "target" | "buffered">): void {
		const target = limits(policy.target);
		const nextCapacity = capacity(this.#config.rate, target.maximum, this.#config.capacityMilliseconds);
		if (nextCapacity > this.#capacity) this.#grow(nextCapacity);
		const changed =
			policy.target.kind !== this.#config.target.kind || !!policy.buffered !== !!this.#config.buffered;
		this.#config = { ...this.#config, ...policy, target: { ...policy.target } };
		this.#limits = target;
		if (changed) {
			this.#resetEstimate();
			this.#level = undefined;
			this.#nextScaleFrame = 0;
		} else {
			if (policy.target.kind === "fixed") this.#estimate = target.initial;
			this.#target = Math.max(target.minimum, Math.min(target.maximum, this.#estimate));
		}
	}

	#grow(size: number): void {
		const planes = Array.from({ length: this.#config.channels }, () => new Float32Array(size));
		const valid = new Uint8Array(size);
		const start = this.#read ?? this.#write;
		for (let position = start; position < Math.min(this.#write, start + this.#capacity); position++) {
			const before = this.#slot(position);
			if (!this.#valid[before]) continue;
			const after = ((position % size) + size) % size;
			for (let channel = 0; channel < planes.length; channel++)
				planes[channel][after] = this.#pcm[channel][before];
			valid[after] = 1;
		}
		this.#pcm = planes;
		this.#valid = valid;
		this.#capacity = size;
		this.#promote();
	}

	/** Whether the first playout cushion has been filled. */
	get playing(): boolean {
		return this.#playing && (this.#endpoint === undefined || (this.#media ?? 0) < this.#endpoint);
	}

	/** Insert equal-length planar samples on the source timeline. */
	insert(timestampMicroseconds: number, planes: Float32Array[], arrivalMilliseconds: number): void {
		if (!Number.isFinite(timestampMicroseconds) || !Number.isFinite(arrivalMilliseconds)) {
			throw new RangeError("invalid PCM timestamp");
		}
		if (planes.length !== this.#config.channels || planes.some((p) => p.length !== planes[0].length)) {
			throw new RangeError("invalid PCM channel layout");
		}
		const length = planes[0].length;
		if (length === 0) return;
		if (length > this.#capacity) throw new RangeError("PCM frame exceeds capacity");
		const start = Math.round((timestampMicroseconds * this.#config.rate) / 1e6);
		if (!Number.isSafeInteger(start + length)) throw new RangeError("PCM timeline exceeds integer precision");
		if (this.#read === undefined) {
			this.#read = start;
			this.#write = start;
			this.#media = start;
			this.#contiguous = start;
		}
		this.#promote();
		const end = Math.min(start + length, this.#endpoint ?? Infinity);
		const offset = Math.max(0, this.#read - start);
		const retained = Math.max(0, end - start - offset);
		const nearEnd = Math.min(end, this.#read + this.#capacity);
		let replaced = 0;
		for (let i = start + offset; i < Math.min(nearEnd, this.#write); i++) replaced += this.#valid[this.#slot(i)];
		const pendingIndex = this.#index(start + offset);
		for (let index = pendingIndex; index < this.#pending.length; index++) {
			const span = this.#pending[index];
			if (!span || span.start >= end) break;
			replaced += Math.max(0, Math.min(end, endOf(span)) - Math.max(start + offset, span.start));
		}
		if (this.#held + retained - replaced > this.#capacity) throw new RangeError("PCM ingress capacity exceeded");
		this.#totals.late += Math.min(length, offset);
		this.#copy(start + offset, planes, offset, Math.max(0, nearEnd - start - offset));
		if (end > Math.max(start + offset, nearEnd)) {
			const deferred = Math.max(start + offset, nearEnd);
			this.#defer(
				deferred,
				planes.map((plane) => plane.slice(deferred - start, end - start)),
				pendingIndex,
			);
		}
		this.#held += retained - replaced;
		this.#write = Math.max(this.#write, end);
		this.#duration = length;
		this.#observe(timestampMicroseconds / 1000, arrivalMilliseconds);
	}

	#index(start: number): number {
		const tail = this.#pending.at(-1);
		if (!tail || endOf(tail) <= start) return this.#pending.length;
		let low = this.#pendingHead;
		let high = this.#pending.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			const span = this.#pending[middle];
			if (!span) throw new Error("missing pending span");
			if (endOf(span) <= start) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	#defer(start: number, planes: Float32Array[], first: number): void {
		const end = start + planes[0].length;
		const existing = this.#pending[first];
		if (existing && existing.start <= start && endOf(existing) >= end) {
			for (let channel = 0; channel < planes.length; channel++)
				existing.planes[channel].set(planes[channel], existing.offset + start - existing.start);
			return;
		}
		const incoming: Pending = { start, planes, offset: 0 };
		if (first === this.#pending.length) {
			const tail = this.#pending.at(-1);
			if (!tail || endOf(tail) !== start) {
				this.#pending.push(incoming);
				return;
			}
			if (tail.offset > 0) {
				const offset = tail.offset;
				tail.planes = tail.planes.map((plane) => plane.slice(offset));
				tail.offset = 0;
			}
			const length = tail.planes[0].length;
			const combined = length + planes[0].length;
			tail.planes = tail.planes.map((plane, channel) => {
				let buffer = plane.buffer;
				if (buffer.byteLength / 4 < combined) {
					const grown = new Float32Array(Math.min(this.#capacity, Math.max(combined, length * 2)));
					grown.set(plane);
					buffer = grown.buffer;
				}
				const joined = new Float32Array(buffer, 0, combined);
				joined.set(planes[channel], length);
				return joined;
			});
			return;
		}
		let after = first;
		let left: Pending | undefined;
		let right: Pending | undefined;
		while (after < this.#pending.length) {
			const span = this.#pending[after];
			if (!span || span.start >= end) break;
			const offset = span.offset;
			const position = span.start;
			if (position < start)
				left = {
					start: position,
					offset: 0,
					planes: span.planes.map((plane) => plane.slice(offset, offset + start - position)),
				};
			if (endOf(span) > end)
				right = {
					start: end,
					offset: 0,
					planes: span.planes.map((plane) => plane.slice(offset + end - position)),
				};
			after++;
		}
		if (left && right) this.#pending.splice(first, after - first, left, incoming, right);
		else if (left) this.#pending.splice(first, after - first, left, incoming);
		else if (right) this.#pending.splice(first, after - first, incoming, right);
		else this.#pending.splice(first, after - first, incoming);
	}

	#compact(): void {
		if (this.#pendingHead === this.#pending.length) this.#pending.length = this.#pendingHead = 0;
		else if (this.#pendingHead >= 1024 && this.#pendingHead * 2 >= this.#pending.length) {
			this.#pending.splice(0, this.#pendingHead);
			this.#pendingHead = 0;
		}
	}

	#promote(): void {
		if (this.#read === undefined) return;
		const limit = this.#read + this.#capacity;
		for (;;) {
			const span = this.#pending[this.#pendingHead];
			if (!span || span.start >= limit) break;
			const end = Math.min(endOf(span), limit);
			this.#copy(span.start, span.planes, span.offset, end - span.start);
			span.offset += end - span.start;
			span.start = end;
			if (span.offset < span.planes[0].length) break;
			this.#pending[this.#pendingHead++] = undefined;
		}
		this.#compact();
	}

	#copy(position: number, planes: Float32Array[], offset: number, length: number): void {
		if (length === 0) return;
		const start = this.#slot(position);
		const first = Math.min(length, this.#capacity - start);
		for (let channel = 0; channel < planes.length; channel++) {
			const source = planes[channel];
			this.#pcm[channel].set(
				offset === 0 && first === source.length ? source : source.subarray(offset, offset + first),
				start,
			);
			if (first < length) this.#pcm[channel].set(source.subarray(offset + first, offset + length), 0);
		}
		this.#valid.fill(1, start, start + first);
		if (first < length) this.#valid.fill(1, 0, length - first);
	}

	/** Render the complete quantum at an explicit AudioContext sample frame. */
	render(output: Float32Array[], outputFrame: number): void {
		if (output.length !== this.#config.channels || output.some((p) => p.length !== output[0].length)) {
			throw new RangeError("invalid render channel layout");
		}
		if (
			!Number.isSafeInteger(outputFrame) ||
			(this.#lastOutputFrame !== undefined && outputFrame < this.#lastOutputFrame)
		) {
			throw new RangeError(
				`render clock moved backwards: ${outputFrame} < ${this.#lastOutputFrame}; quantum=${output[0].length}`,
			);
		}
		this.#lastOutputFrame = outputFrame + output[0].length;
		let offset = 0;
		while (offset < output[0].length) {
			if (this.#blockOffset === this.#blockLength) this.#produce(outputFrame + offset, output[0].length - offset);
			const count = Math.min(output[0].length - offset, this.#blockLength - this.#blockOffset);
			for (let i = 0; i < count; i++) {
				for (let channel = 0; channel < output.length; channel++) {
					const value = this.#block[channel][this.#blockOffset + i];
					output[channel][offset + i] = value;
					this.#history[channel][this.#historyCount % this.#historySize] = value;
				}
				this.#historyCount++;
			}
			const consumed = (count * this.#blockConsumed) / this.#blockLength;
			if (this.#blockKind === "real") {
				this.#totals.consumed += consumed;
				this.#totals.expanded += Math.max(0, count - consumed);
				this.#totals.accelerated += Math.max(0, consumed - count);
			} else if (this.#blockKind === "concealed") this.#totals.concealed += count;
			else this.#totals.silent += count;
			this.#blockOffset += count;
			if (this.#read !== undefined)
				this.#media = this.#blockStart + (this.#blockConsumed * this.#blockOffset) / this.#blockLength;
			offset += count;
		}
	}

	/** Clear the media timeline on the same render clock, retaining cumulative statistics. */
	reset(): void {
		this.#valid.fill(0);
		this.#pending.length = this.#pendingHead = 0;
		this.#held = 0;
		this.#contiguous = 0;
		this.#read = undefined;
		this.#media = undefined;
		this.#write = 0;
		this.#endpoint = undefined;
		this.#playing = false;
		this.#blockOffset = this.#blockLength = 0;
		this.#historyCount = this.#loss = this.#merge = this.#mergePosition = 0;
		this.#concealReady = false;
		this.#backgroundEnergy = initialBackgroundEnergy;
		this.#backgroundThreshold = initialBackgroundThreshold;
		this.#backgroundMaximum = 0;
		this.#backgroundReady = false;
		this.#level = undefined;
		this.#duration = 0;
		this.#nextScaleFrame = 0;
		this.#resetEstimate();
	}

	#resetEstimate(): void {
		this.#estimate = this.#limits.initial;
		this.#target = Math.max(this.#limits.minimum, Math.min(this.#limits.maximum, this.#estimate));
		this.#arrivals = [];
		this.#arrivalHead = 0;
		this.#newestArrivalTimestamp = -Infinity;
		this.#intervalStart = undefined;
		this.#intervalMaximum = 0;
		this.#histogram.fill(0);
	}

	/** Remove the unrendered predecessor tail at a rendition takeover. */
	truncate(timestampMicroseconds: number, endpoint?: number): void {
		if (!Number.isFinite(timestampMicroseconds)) throw new RangeError("invalid truncate timestamp");
		if (endpoint !== undefined && !Number.isFinite(endpoint)) throw new RangeError("invalid endpoint");
		this.#endpoint = endpoint === undefined ? undefined : Math.round((endpoint * this.#config.rate) / 1e6);
		if (this.#read === undefined) return;
		const requested = Math.round((timestampMicroseconds * this.#config.rate) / 1e6);
		const cutoff = Math.max(this.#media ?? this.#read, requested);
		if (cutoff < this.#read) {
			// Preserve the pending output before the cutoff, including its time-scale mapping.
			const ratio = this.#blockConsumed / this.#blockLength;
			const retained = Math.max(this.#blockOffset, Math.floor((cutoff - this.#blockStart) / ratio));
			this.#blockLength = retained;
			this.#blockConsumed = retained * ratio;
			this.#read = Math.ceil(cutoff);
		}
		for (
			let i = Math.max(this.#read, Math.ceil(cutoff));
			i < Math.min(this.#write, this.#read + this.#capacity);
			i++
		) {
			const slot = this.#slot(i);
			this.#held -= this.#valid[slot];
			this.#valid[slot] = 0;
		}
		const first = this.#index(Math.ceil(cutoff));
		let retained = first;
		for (let index = first; index < this.#pending.length; index++) {
			const span = this.#pending[index];
			if (!span) throw new Error("missing pending span");
			this.#held -= endOf(span) - Math.max(span.start, Math.ceil(cutoff));
			if (span.start < cutoff) {
				const offset = span.offset;
				const frames = Math.ceil(cutoff) - span.start;
				span.planes = span.planes.map((plane) => plane.slice(offset, offset + frames));
				span.offset = 0;
				retained++;
			}
		}
		this.#pending.length = retained;
		this.#compact();
		this.#contiguous = Math.min(this.#contiguous, Math.ceil(cutoff));
		this.#write = Math.min(this.#write, Math.ceil(cutoff));
	}

	/** Declare the exclusive media endpoint, after which concealment also stops. */
	end(timestampMicroseconds: number): void {
		if (!Number.isFinite(timestampMicroseconds)) throw new RangeError("invalid endpoint");
		this.truncate(timestampMicroseconds, timestampMicroseconds);
	}

	/** The source position represented by samples emitted so far, in microseconds. */
	get timestamp(): number | undefined {
		return this.#media === undefined ? undefined : (this.#media * 1e6) / this.#config.rate;
	}

	/** Read cumulative sample counters and retained PCM frames per channel. */
	get stats(): Stats {
		return {
			...this.#totals,
			queueSamples: this.#held,
			targetMilliseconds: this.#target,
		};
	}

	#slot(position: number): number {
		return ((position % this.#capacity) + this.#capacity) % this.#capacity;
	}

	#available(limit: number): number {
		if (this.#read === undefined) return 0;
		this.#contiguous = Math.max(this.#contiguous, this.#read);
		while (
			this.#contiguous < Math.min(this.#write, this.#read + this.#capacity) &&
			this.#valid[this.#slot(this.#contiguous)]
		)
			this.#contiguous++;
		return Math.min(limit, this.#contiguous - this.#read);
	}

	#produce(outputFrame: number, requested: number): void {
		this.#blockOffset = 0;
		this.#blockLength = Math.min(requested, this.#blockSize);
		this.#blockConsumed = 0;
		this.#blockStart = this.#media ?? 0;
		this.#blockKind = "silent";
		for (const channel of this.#block) channel.fill(0);
		if (this.#read === undefined) return;
		this.#promote();
		const target = (this.#target * this.#config.rate) / 1000;
		const available = this.#available(this.#capacity);
		let level = available;
		let reachable = available;
		const initial = !this.#playing && this.#loss < this.#concealSize;
		if (!this.#config.buffered && (initial || available >= this.#blockSize) && available < this.#held) {
			// PCM beyond a gap longer than concealment cannot support this utterance's playout rate.
			let gap = 0;
			let slot = this.#slot(this.#read + available);
			const limit = Math.min(this.#write - this.#read, this.#capacity);
			for (let offset = available; offset < limit; offset++) {
				if (this.#valid[slot]) {
					level++;
					reachable = offset + 1;
					gap = 0;
				} else if (++gap > this.#concealSize) break;
				if (++slot === this.#capacity) slot = 0;
			}
		}
		if (!this.#playing) {
			const cushion = !this.#config.buffered && initial ? reachable : this.#write - this.#read;
			if (cushion < Math.max(1, target) && this.#endpoint === undefined) return;
			this.#playing = true;
		}
		if (this.#endpoint !== undefined && this.#read >= this.#endpoint) return;
		this.#blockStart = this.#read;
		const remaining = this.#endpoint === undefined ? Infinity : this.#endpoint - this.#read;
		if (available === 0) {
			// Once concealment has faded, wait for a new cushion instead of outrunning every late packet.
			// Known future samples and explicit endpoints still define gaps on the source timeline.
			if (this.#loss >= this.#concealSize && this.#held === 0 && this.#endpoint === undefined) {
				this.#playing = false;
				this.#level = undefined;
				return;
			}
			this.#blockLength = Math.min(this.#blockLength, remaining);
			for (let i = 1; i < this.#blockLength; i++) {
				if (this.#valid[this.#slot(this.#read + i)]) {
					this.#blockLength = i;
					break;
				}
			}
			this.#conceal();
			this.#blockConsumed = this.#blockLength;
			this.#read += this.#blockConsumed;
			return;
		}
		const length = Math.min(this.#blockSize, available, remaining);
		let shift = 0;
		if (!this.#config.buffered && length === this.#blockSize) {
			this.#level = this.#level === undefined ? level : this.#level + (level - this.#level) * 0.08;
			if (outputFrame >= this.#nextScaleFrame) {
				const deadband = Math.max(this.#overlap, this.#duration / 2);
				if (this.#level > target + deadband && available >= length + this.#maxLag) shift = this.#lag(1);
				else if (this.#level < target - deadband && target >= this.#blockSize) shift = -this.#lag(-1);
			}
			if (shift !== 0) {
				this.#nextScaleFrame = outputFrame + Math.round(this.#config.rate * 0.1);
				this.#level -= shift;
			}
		}
		if (length === this.#blockSize && shift === 0) this.#observeBackground(length);
		const splice = this.#maxLag;
		for (let channel = 0; channel < this.#block.length; channel++) {
			for (let i = 0; i < length; i++) {
				const first = this.#pcm[channel][this.#slot(this.#read + i)];
				if (shift === 0 || i < splice) this.#block[channel][i] = first;
				else {
					const second = this.#pcm[channel][this.#slot(this.#read + i + shift)];
					const mix = Math.min(1, (i - splice + 1) / this.#overlap);
					this.#block[channel][i] = first * (1 - mix) + second * mix;
				}
			}
		}
		this.#blockLength = length;
		this.#blockConsumed = length + shift;
		this.#blockKind = "real";
		if (this.#loss > 0) {
			this.#extendConcealment(this.#loss + this.#overlap);
			this.#merge = this.#overlap;
			this.#mergePosition = this.#loss;
		}
		for (let i = 0; i < length && this.#merge > 0; i++, this.#merge--, this.#mergePosition++) {
			const mix = 1 - this.#merge / this.#overlap;
			for (let channel = 0; channel < this.#block.length; channel++) {
				this.#block[channel][i] =
					this.#predicted(channel, this.#mergePosition) * (1 - mix) + this.#block[channel][i] * mix;
			}
		}
		this.#loss = 0;
		for (let i = 0; i < this.#blockConsumed; i++) this.#valid[this.#slot(this.#read + i)] = 0;
		this.#held -= this.#blockConsumed;
		this.#read += this.#blockConsumed;
	}

	#lag(direction: 1 | -1): number {
		const read = this.#read;
		if (read === undefined) return 0;
		let best = this.#minLag;
		let score = -Infinity;
		let energy = Infinity;
		const stride = Math.max(1, Math.ceil(this.#config.rate / 12000));
		const samples = Math.ceil(this.#overlap / stride) * this.#pcm.length;
		// Decimation bounds correlation work independently of render-quantum size.
		for (let lag = this.#minLag; lag <= this.#maxLag; lag += stride) {
			let dot = 0;
			let firstEnergy = 0;
			let secondEnergy = 0;
			for (let i = 0; i < this.#overlap; i += stride) {
				for (const channel of this.#pcm) {
					const a = channel[this.#slot(read + this.#maxLag + i)];
					const b = channel[this.#slot(read + this.#maxLag + i + direction * lag)];
					dot += a * b;
					firstEnergy += a * a;
					secondEnergy += b * b;
				}
			}
			const correlation = dot / Math.sqrt(Math.max(1e-20, firstEnergy * secondEnergy));
			if (correlation > score) {
				score = correlation;
				best = lag;
				energy = (firstEnergy + secondEnergy) / (2 * samples);
			}
		}
		const background = this.#backgroundReady ? this.#backgroundEnergy : initialPassiveEnergy;
		return score >= 0.5 || energy <= 8 * background ? best : 0;
	}

	#observeBackground(length: number): void {
		const read = this.#read;
		if (read === undefined || length < 2) return;
		const stride = Math.max(1, Math.ceil(this.#config.rate / 12000));
		let energy = 0;
		let previousEnergy = 0;
		let correlation = 0;
		let count = 0;
		for (let i = stride; i < length; i += stride) {
			for (const channel of this.#pcm) {
				const sample = channel[this.#slot(read + i)];
				const previous = channel[this.#slot(read + i - stride)];
				energy += sample * sample;
				previousEnergy += previous * previous;
				correlation += sample * previous;
				count++;
			}
		}
		if (count === 0) return;
		energy /= count;
		const coefficient = Math.max(-0.98, Math.min(0.98, correlation / Math.max(1e-20, previousEnergy)));
		let residualEnergy = 0;
		for (let i = stride; i < length; i += stride) {
			for (const channel of this.#pcm) {
				const sample = channel[this.#slot(read + i)];
				const previous = channel[this.#slot(read + i - stride)];
				const residual = sample - coefficient * previous;
				residualEnergy += residual * residual;
			}
		}
		residualEnergy /= count;
		if (energy < this.#backgroundThreshold) {
			this.#backgroundThreshold = Math.max(1 / pcmScale, energy);
			if (Math.abs(coefficient) < 0.98 && residualEnergy >= energy * 0.05) {
				this.#backgroundEnergy = Math.max(1 / pcmScale, energy);
				this.#backgroundReady = true;
			}
			return;
		}
		const duration = length / this.#config.rate;
		// Match NetEQ's slow search for a higher stationary noise floor.
		this.#backgroundThreshold *= 4 ** (duration / 4);
		this.#backgroundMaximum *= (1023 / 1024) ** (duration / 0.01);
		this.#backgroundMaximum = Math.max(this.#backgroundMaximum, energy);
		this.#backgroundThreshold = Math.max(this.#backgroundThreshold, this.#backgroundMaximum / 1e6);
	}

	#conceal(): void {
		if (this.#loss === 0) this.#prepareConcealment();
		this.#extendConcealment(this.#loss + this.#blockLength);
		this.#blockKind = this.#concealReady && this.#loss < this.#concealSize ? "concealed" : "silent";
		for (let channel = 0; channel < this.#block.length; channel++) {
			for (let i = 0; i < this.#blockLength; i++)
				this.#block[channel][i] = this.#predicted(channel, this.#loss + i);
		}
		this.#loss += this.#blockLength;
	}

	#predicted(channel: number, loss: number): number {
		return this.#concealReady && loss < this.#concealment.generated ? this.#concealment.output[channel][loss] : 0;
	}

	#prepareConcealment(): void {
		const historyLength = Math.min(this.#historyCount, this.#historySize);
		if (historyLength === 0) {
			this.#concealReady = false;
			return;
		}
		let period = Math.min(this.#maxLag, historyLength);
		let bestScore = 0;
		if (historyLength >= this.#maxLag + this.#overlap) {
			const stride = Math.max(1, Math.ceil(this.#config.rate / 12000));
			for (let lag = this.#minLag; lag <= this.#maxLag; lag += stride) {
				let dot = 0;
				let firstEnergy = 0;
				let secondEnergy = 0;
				for (let i = 0; i < this.#overlap; i += stride) {
					for (let channel = 0; channel < this.#history.length; channel++) {
						const first = this.#historyAt(channel, this.#historyCount - this.#overlap + i);
						const second = this.#historyAt(channel, this.#historyCount - this.#overlap - lag + i);
						dot += first * second;
						firstEnergy += first * first;
						secondEnergy += second * second;
					}
				}
				const score = dot / Math.sqrt(Math.max(1e-20, firstEnergy * secondEnergy));
				if (score > bestScore) {
					bestScore = score;
					period = lag;
				}
			}
		}
		const start = this.#historyCount - historyLength;
		const residualLength = Math.max(1, historyLength - 1);
		const concealment = this.#concealment;
		for (let channel = 0; channel < this.#history.length; channel++) {
			for (let i = 0; i < period; i++) {
				concealment.periodic[channel][i] = this.#historyAt(channel, this.#historyCount - period + i);
			}
			let dot = 0;
			let energy = 0;
			for (let i = 1; i < historyLength; i++) {
				const previous = this.#historyAt(channel, start + i - 1);
				dot += this.#historyAt(channel, start + i) * previous;
				energy += previous * previous;
			}
			concealment.ar[channel] = Math.max(-0.98, Math.min(0.98, dot / Math.max(1e-20, energy)));
			concealment.state[channel] = this.#historyAt(channel, this.#historyCount - 1);
			for (let i = 0; i < residualLength; i++) {
				if (historyLength === 1) {
					concealment.residual[channel][i] = concealment.state[channel];
					continue;
				}
				const previous = this.#historyAt(channel, start + i);
				concealment.residual[channel][i] =
					this.#historyAt(channel, start + i + 1) - concealment.ar[channel] * previous;
			}
		}
		concealment.period = period;
		concealment.residualLength = residualLength;
		concealment.voice = voiceMix(bestScore);
		concealment.generated = 0;
		concealment.seed = (this.#historyCount ^ 0x9e3779b9) >>> 0 || 1;
		this.#concealReady = true;
	}

	#extendConcealment(requested: number): void {
		const concealment = this.#concealment;
		if (!this.#concealReady) return;
		const end = Math.min(this.#concealSize, Math.ceil(requested));
		for (let i = concealment.generated; i < end; i++) {
			concealment.seed ^= concealment.seed << 13;
			concealment.seed ^= concealment.seed >>> 17;
			concealment.seed ^= concealment.seed << 5;
			concealment.seed >>>= 0;
			const residualIndex = concealment.seed % concealment.residualLength;
			const transition = Math.min(1, (i + 1) / this.#overlap);
			const voiced = 1 - transition * (1 - concealment.voice);
			const gain = 1 - i / this.#concealSize;
			for (let channel = 0; channel < concealment.output.length; channel++) {
				concealment.state[channel] =
					concealment.ar[channel] * concealment.state[channel] + concealment.residual[channel][residualIndex];
				const periodic = concealment.periodic[channel][i % concealment.period];
				concealment.output[channel][i] = (periodic * voiced + concealment.state[channel] * (1 - voiced)) * gain;
			}
		}
		concealment.generated = Math.max(concealment.generated, end);
	}

	#historyAt(channel: number, position: number): number {
		return this.#history[channel][position % this.#historySize];
	}

	#observe(timestamp: number, arrived: number): void {
		if (this.#config.target.kind !== "auto" || this.#config.buffered || timestamp <= this.#newestArrivalTimestamp)
			return;
		this.#newestArrivalTimestamp = timestamp;
		const delay = arrived - timestamp;
		// Ordered performance.now() observations let newer minima replace older candidates.
		while (this.#arrivalHead < this.#arrivals.length && arrived - this.#arrivals[this.#arrivalHead].arrived > 2000)
			this.#arrivalHead++;
		while (this.#arrivals.length > this.#arrivalHead && this.#arrivals[this.#arrivals.length - 1].delay >= delay)
			this.#arrivals.pop();
		this.#arrivals.push({ arrived, delay });
		if (this.#arrivalHead >= 1024 && this.#arrivalHead * 2 >= this.#arrivals.length) {
			this.#arrivals.splice(0, this.#arrivalHead);
			this.#arrivalHead = 0;
		}
		const minimum = this.#arrivals[this.#arrivalHead].delay;
		this.#intervalStart ??= arrived;
		if (arrived - this.#intervalStart >= 500) {
			for (let i = 0; i < this.#histogram.length; i++) this.#histogram[i] *= 0.983;
			this.#histogram[Math.min(99, Math.floor(this.#intervalMaximum / 20))]++;
			let total = 0;
			for (const count of this.#histogram) total += count;
			let cumulative = 0;
			for (let i = 0; i < this.#histogram.length; i++) {
				cumulative += this.#histogram[i];
				if (cumulative >= total * 0.95) {
					this.#estimate = (i + 1) * 20 + (this.#duration * 1000) / this.#config.rate;
					this.#target = Math.max(this.#limits.minimum, Math.min(this.#limits.maximum, this.#estimate));
					break;
				}
			}
			this.#intervalStart = arrived;
			this.#intervalMaximum = 0;
		}
		this.#intervalMaximum = Math.max(this.#intervalMaximum, delay - minimum);
	}
}
