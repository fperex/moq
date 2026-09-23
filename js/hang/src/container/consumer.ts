import type { Time } from "@moq/net";
import * as Moq from "@moq/net";
import { Effect, type Getter, type GetterInit, getter, Once, Signal } from "@moq/signals";

import type { Format } from "./format";
import { Jitter } from "./jitter";
import { Stall } from "./stall";
import type { BufferedRanges, Frame } from "./types";

/** Options for constructing a {@link Consumer}. */
export interface ConsumerProps {
	/** The container format used to decode each MoQ frame. */
	format: Format;
	/**
	 * How stale a group may get before it is skipped, in milliseconds (default: 0).
	 *
	 * A group is measured by how far it could still present, which the first timestamp of the next
	 * group holding a frame bounds, against the newest frame the track has reached. So it bounds
	 * how long a late or missing group is waited for without reading a long group as a late one.
	 * The local half of the subscription's `maxAge`; both measure the same budget, one on the wire
	 * and one as frames are read.
	 */
	// Read-only: a Getter (e.g. another component's output) is accepted directly.
	maxAge?: GetterInit<Time.Milli>;

	/**
	 * Where {@link Consumer.spread} starts: the rendition's declared flush span, or an estimator
	 * already measuring this rendition (default: neither, so the estimator's own guess).
	 *
	 * A duration is the publisher's catalog `jitter`, a prior the first measurement replaces. A
	 * {@link Jitter} is a measurement already made: a receiver that stops and restarts reading the
	 * same rendition hands its estimator to the replacement consumer rather than starting over at
	 * the declaration, which is a guess it has already improved on. The consumer reanchors it,
	 * since the arrival reference describes a stretch of timeline nobody was reading.
	 *
	 * A plain value, not a getter: a rendition that changes its declaration is a different
	 * rendition and gets a new consumer.
	 */
	jitter?: Time.Milli | Jitter;
}

interface Group {
	consumer: Moq.Group.Consumer;
	frames: Frame[]; // decode order
	empty: boolean; // no wire frame was published; empty groups mean nothing
	media: boolean; // a decodable (non-marker) frame was buffered
	start?: Time.Micro; // First decoded timestamp
	minMedia?: Time.Micro; // Lowest decodable timestamp
	latest?: Time.Micro; // The timestamp of the latest known frame
	end?: Time.Micro; // The furthest presentation point so far, i.e. max(timestamp + duration)
	done?: boolean; // Set when #runGroup finishes reading all frames
	truncated?: boolean; // The missing tail becomes a gap after the buffered frames are delivered.
}

// Two adjacent groups are treated as timeline-contiguous when the next group's first PTS is within
// this slack of the current group's end. Per-sample durations and base-decode-times are each rounded
// to microseconds independently, so a genuinely contiguous boundary can be off by ~1µs (seen on 48kHz
// audio). A real missing group spans ~one group duration (orders of magnitude larger), so 1ms cleanly
// separates rounding noise from an actual gap.
const CONTIGUITY_TOLERANCE = Moq.Time.Micro.fromMilli(1 as Time.Milli);

/**
 * True when `nextStart` continues the timeline that ends at `end`: it lands at or before `end`,
 * within CONTIGUITY_TOLERANCE to absorb the µs rounding of independently-rounded per-sample
 * durations and base-decode-times. Undefined on either side means continuity can't be proven.
 *
 * The bound is one-sided (upper only) by design: a next start at or before `end` continues the
 * timeline, a start past `end` beyond the tolerance is a gap. A start well before `end` is
 * malformed and aborts the track.
 */
function ptsContiguous(end: Time.Micro | undefined, nextStart: Time.Micro | undefined): boolean {
	return end !== undefined && nextStart !== undefined && nextStart <= Moq.Time.Micro.add(end, CONTIGUITY_TOLERANCE);
}

/**
 * True when `next` continues `prev`'s presentation timeline, i.e. nothing is missing between them.
 * Either its sequence is the very next one, which is the only proof available for containers that
 * carry no per-frame duration (Legacy), or the PTS timeline is unbroken across the boundary, which
 * is what non-sequential group numbering (e.g. DTS-derived ids) needs.
 */
function continues(prev: Group, next: Group | undefined): next is Group {
	if (next === undefined) return false;
	return (
		next.consumer.sequence === prev.consumer.sequence + 1 || ptsContiguous(prev.end, next.frames.at(0)?.timestamp)
	);
}

/** Reads frames from a MoQ track in order, buffering groups and skipping ones that age past `maxAge`. */
export class Consumer {
	#track: Moq.Track.Subscriber;
	#format: Format;
	#maxAge: Getter<Time.Milli>;
	#groups: Group[] = [];
	#active?: number; // the active group sequence number
	// Presentation end (max PTS + duration) of the group we most recently advanced past, so next()'s
	// promotion guard can tell a timeline-continuous next group from one sitting after a gap.
	// Maintained only via #recordPresented; see its comment for the invariant.
	#presentedEnd?: Time.Micro;
	// Group of the last frame next() returned, so it can report whether the following result
	// continues that frame's timeline. Undefined until the first delivery and after a playhead event.
	#deliveredGroup?: number;
	// Set whenever the consumer throws content away: a group that aged past `maxAge`,
	// a group truncated by a decode error. Reported (and
	// cleared) on the first frame delivered from the next group, which is where the missing span
	// sits. Only the consumer can know this, which is why next() reports it instead of leaving
	// callers to guess from group numbers.
	#gap = false;
	// The live edge of playback: max delivered timestamp and the group that carried it.
	#liveEdge?: { group: number; timestamp: Time.Micro };
	// Increments on a declared marker, an unproven delivered hole, and a latency skip.
	#discontinuity = 0;
	// A group below the live edge aborts the track.
	#error?: Error;

	// Wake up the consumer when a new frame is available.
	#notify?: () => void;

	#buffered = new Signal<BufferedRanges>([]);
	/** The time ranges currently buffered and ready to play. */
	readonly buffered: Getter<BufferedRanges> = this.#buffered;

	// Measured at arrival, before any group is skipped: a target derived from what survives the
	// age budget would only ever confirm the budget it was cut to.
	#spread: Jitter;

	// Whether this receiver's own event loop was blocked before an arrival. The estimator cannot see
	// that in the arrival timing, since a blocked receiver and a bursty path read the same there.
	#stall = Stall.acquire();

	/**
	 * How late frames arrive relative to the earliest one, measured as they land.
	 *
	 * Size the playback buffer with this rather than with the round trip, which says nothing about
	 * how evenly a publisher emits frames. Starts at {@link ConsumerProps.jitter}: the publisher's
	 * own declaration until the first arrivals replace it, or what a handed-in estimator already
	 * measured.
	 */
	readonly spread: Getter<Time.Milli>;

	#skipped = new Signal(0);

	/** Groups that lost content because the local age budget skipped them or the transport gave up. */
	readonly skipped: Getter<number> = this.#skipped;

	#signals = new Effect();
	#closed = new Once<Error | null>();

	/** Start consuming the given track, decoding frames with `props.format`. */
	constructor(track: Moq.Track.Subscriber, props: ConsumerProps) {
		this.#track = track;
		this.#format = props.format;
		this.#maxAge = getter(props.maxAge ?? Moq.Time.Milli.zero);
		if (props.jitter instanceof Jitter) {
			// Continuing a measurement: keep the distribution, drop the arrival reference, which
			// describes a stretch of timeline this receiver was not reading.
			this.#spread = props.jitter;
			this.#spread.reanchor();
		} else {
			this.#spread = new Jitter({ start: props.jitter });
		}
		this.spread = this.#spread.value;

		this.#signals.run((effect) => {
			effect.get(this.#maxAge);
			this.#checkMaxAge();
		});
		this.#signals.spawn(this.#run.bind(this));
		this.#signals.cleanup(() => {
			this.#stall.close();
			this.#track.close();
			for (const group of this.#groups) {
				group.consumer.close();
			}
			this.#groups.length = 0;
		});
	}

	#finish(end: Error | null): void {
		if (this.#closed.peek() === undefined) this.#closed.set(end);
		this.#notify?.();
		this.#notify = undefined;
	}

	async #run() {
		// Start fetching groups in the background
		try {
			for (;;) {
				const consumer = await this.#track.recvGroup();
				if (!consumer) break;

				// To improve TTV, we always start with the first group.
				// For higher latencies we might need to figure something else out, as its racey.
				if (this.#active === undefined) {
					this.#active = consumer.sequence;
				}

				// Arriving below the delivery cursor is not a reason to drop a group. Groups are
				// sent newest-first, so the head of a subscription arrives after the live edge it
				// was served alongside, and both consumers can still place one: audio writes into
				// a timestamp-indexed ring, video drops a late frame at render. How far back one
				// may be is the subscription's own max age, applied before it ever reaches here.
				const group: Group = {
					consumer,
					frames: [],
					empty: true,
					media: false,
				};

				// Insert into #groups based on the group sequence number (ascending).
				// This is used to cancel old groups.
				this.#groups.push(group);
				this.#groups.sort((a, b) => a.consumer.sequence - b.consumer.sequence);

				// Start buffering frames from this group
				this.#signals.spawn(this.#runGroup.bind(this, group));
			}
			this.#finish(null);
		} catch (err) {
			this.#finish(err instanceof Error ? err : new Error(String(err)));
		}
	}

	async #runGroup(group: Group) {
		try {
			let index = 0;

			for (;;) {
				const next = await group.consumer.readFrame();
				if (!next) break;
				group.empty = false;

				// One arrival time per wire frame, read before the payload is parsed: every sample a
				// container frame carries reached the receiver together, so sampling the clock per
				// sample would fold this receiver's decode cost into a measurement of the path, and
				// fold it in proportionally to the segment size.
				const now = Moq.Time.Milli.now();
				// Asked at the same instant, because the answer is about this arrival: a block that
				// ended a tick ago is what this frame spent queued rather than in flight.
				const stalled = this.#stall.blocked(now);
				const decoded = this.#format.decode(next.payload);

				for (const sample of decoded) {
					const marker = this.#format.end?.(sample) !== undefined;
					const frame: Frame = {
						payload: sample.payload,
						timestamp: sample.timestamp,
						// Protocol invariant: groups always start at a keyframe.
						// For index 0, we enforce this regardless of what the format reports.
						// For index > 0, we trust the format's keyframe detection.
						keyframe: !marker && index === 0 ? true : sample.keyframe,
						// Carry the container's per-sample duration through so group.end is the real
						// presentation end (ts + duration), not just the last frame's ts. This is what
						// makes the PTS-contiguity check (next.firstPTS <= group.end) work; without it a
						// contiguous next group looks one frame past the end. Undefined for Legacy (no duration).
						duration: sample.duration,
					};

					if (!marker) {
						index++;
						group.media = true;
						if (group.minMedia === undefined || frame.timestamp < group.minMedia) {
							group.minMedia = frame.timestamp;
						}
					}

					group.start ??= frame.timestamp;
					group.frames.push(frame);

					if (group.latest === undefined || frame.timestamp > group.latest) {
						group.latest = frame.timestamp;
					}

					const end = (frame.timestamp + (frame.duration ?? 0)) as Time.Micro;
					if (group.end === undefined || end > group.end) {
						group.end = end;
					}

					this.#updateBuffered();

					if (!marker && this.#abortIfRewound(group, frame.timestamp)) return;

					// Measured once the timeline is settled and before the age budget can skip
					// the group: a reneged straggler is already gone, a rewound group has already
					// aborted the track above, and a target derived from what survives the budget
					// would only ever confirm the budget it was cut to.
					if (!marker) this.#spread.observe(frame.timestamp, now, { stalled });

					let skipped = false;
					if (group.consumer.sequence !== this.#active) {
						// A non-active group can also be too slow to wait for. This runs even when
						// the group is the delivery head, because that is exactly the stalled case
						// (#active sits below every buffered group) where the max age budget is
						// what eventually breaks the stall.
						this.#checkMaxAge();

						// A newer group reaching back to where the stalled active group has
						// already presented means we can advance now instead of waiting.
						skipped = this.#tryDurationSkip();
					}

					// Wake next() for the current delivery head so its frames surface as they
					// arrive. Gating only on `=== #active` assumed +1 group numbering: with
					// non-sequential group ids (large jumps between groups) #active lags one group
					// behind as a stale `+1` phantom, so the real head never matched and its whole
					// group was held until completion, then flushed in a burst. The earliest
					// buffered group is the delivery head regardless of id scheme; next()'s
					// promotion guard advances #active to it. Works for sequential and
					// non-sequential ids alike.
					if (skipped || group.consumer.sequence === this.#active || group === this.#groups[0]) {
						this.#notify?.();
						this.#notify = undefined;
					}
				}
			}
		} catch (err) {
			if (this.#error) return;
			// Stop reading the group but keep already-decoded frames.
			// A decode error or stream RESET truncates the tail of the GoP;
			// frames decoded before the error are still valid and playable.
			// The tail is gone though, so the next group does not continue this one.
			group.truncated = true;
			if (!(err instanceof Moq.Error.Stream)) throw err;

			// A stream verdict is a delivery outcome, not a task failure: the subscription's
			// max age gave up on the group (Expired), the cache dropped it (TooFarBehind), the
			// publisher reset it. Counting it here rather than rethrowing is what keeps a
			// routine skip out of the effect's `spawn error` log, and what lets a viewer see
			// that content was censored above the decoder.
			this.#skipped.set(this.#skipped.peek() + 1);
		} finally {
			group.done = true;

			if (group.consumer.sequence === this.#active) {
				this.#recordPresented(group);

				// Advance to the next buffered group's actual sequence, but ONLY if it continues this
				// group's timeline. Some encoders number groups non-sequentially with large gaps (not
				// +1), so a bare `+= 1` would point #active at a nonexistent sequence and stall next()
				// until #checkMaxAge skipped it -- every group through the skip path, i.e. constant
				// stutter. A real PTS gap is different: an intermediate group may still be in transit,
				// so fall back to +1 there (next()'s promotion guard fixes it up once a continuous
				// group arrives) and let #checkMaxAge / #tryDurationSkip skip the gap only once
				// age or duration coverage proves it too old.
				const next = this.#groups[this.#groups.indexOf(group) + 1];
				this.#active = continues(group, next) ? next.consumer.sequence : group.consumer.sequence + 1;
			}
			this.#checkMaxAge();

			// Recompute buffered ranges now that this group is done,
			// so consecutive done groups can merge into a single range.
			this.#updateBuffered();

			// Always notify - the consumer may need to advance past this group
			// even if it wasn't active when this task finished.
			this.#notify?.();
			this.#notify = undefined;

			group.consumer.close();
		}
	}

	// Record where a group's content ends as the cursor advances past it. next()'s promotion guard
	// compares the following group's first PTS against this to tell an unbroken timeline from a real
	// gap, so EVERY site that moves #active past a group must call this; a site that forgets leaves a
	// stale end behind and silently blocks the next contiguous group forever. A group with no frames
	// (empty, or errored before the first one) says nothing about the timeline, so it leaves the last
	// known end in place rather than wiping it.
	#recordPresented(group: Group): void {
		if (group.end !== undefined) this.#presentedEnd = group.end;
	}

	// Whether delivering from group `sequence` continues the timeline of the last frame returned.
	// Frames within a group are consecutive by protocol, so only a group boundary can break it, and
	// there it comes down to whether anything was dropped in between. Deliberately not derived from
	// group numbers: they need not be sequential, so adjacency neither proves continuity nor catches
	// a group the max age check truncated on the way past.
	#continuesDelivery(sequence: number): boolean {
		if (this.#deliveredGroup === undefined) return false;
		return sequence === this.#deliveredGroup || !this.#gap;
	}

	#checkMaxAge() {
		if (this.#active === undefined) return;

		let skipped = false;
		let walked = false;
		let hole = false;

		// A cursor below every buffered group sits on sequences that never arrived, and none of them
		// can present past where the head begins. Give them up once the head's own first frame has
		// aged past the budget, even while the head is the only group buffered or is still
		// downloading: waiting for a second group to measure against held the picture on the last
		// group played for a whole GOP. `rs/moq-mux` walks its cursor on the same rule.
		const head = this.#groups[0];
		if (head?.start !== undefined && head.consumer.sequence > this.#active) {
			let live: number = head.start;
			for (const group of this.#groups) {
				if (group.latest !== undefined && group.latest > live) live = group.latest;
			}
			if (live - head.start >= Moq.Time.Micro.fromMilli(this.#maxAge.peek())) {
				// As for the walk below: a head that does not continue the timeline we left off at
				// means a span of media is missing, which the reader has to be told.
				if (!ptsContiguous(this.#presentedEnd, head.frames.at(0)?.timestamp)) hole = true;
				this.#active = head.consumer.sequence;
				walked = true;
			}
		}

		// Walk the delivery cursor forward while what the oldest group could still present has aged
		// past the budget. What happens to the oldest group when the budget runs out depends on what
		// it holds; see the verdict below.
		while (!walked && this.#groups.length >= 2) {
			const threshold = Moq.Time.Micro.fromMilli(this.#maxAge.peek());
			const first = this.#groups[0];
			// Where delivery stands, which decides what a verdict against the head means.
			const cursor = this.#active;

			// A group is measured by how far it could still reach, not by how far behind it
			// started: it cannot present past where the next group holding a frame begins, so
			// that bound is the freshest thing still worth waiting for, and the newest frame the
			// track has reached is what it has aged against. This is the wire budget's rule
			// verbatim (`Subscription::max_age`, `is_stale` in `rs/moq-net/src/model/track.rs`),
			// which is the point: the two halves of one budget cannot be allowed to disagree.
			//
			// Measuring the head's own oldest undelivered frame instead makes the verdict a
			// function of the group's length. Audio groups hold one frame, so it reads as
			// lateness; a 2s video GOP whose tail is merely late is convicted the moment its
			// successor opens, throwing away the rest of the GOP and leaving the picture frozen
			// until the next keyframe, once per GOP for as long as the path stays slow.
			//
			// Stopping at the immediate successor instead is no bound at all when that successor
			// holds nothing: a starved path opens groups it never fills, so the head is waited on
			// forever while the groups behind those hold seconds of playable media. Only a group
			// with a frame says where the timeline resumes, which is what `rs/moq-mux` measures
			// against too.
			let reach: Time.Micro | undefined;
			for (let i = 1; i < this.#groups.length && reach === undefined; i++) {
				reach = this.#groups[i].start;
			}
			if (reach === undefined) break;

			let live: number | undefined;
			for (const group of this.#groups) {
				if (group.latest === undefined) continue;
				if (live === undefined || group.latest > live) live = group.latest;
			}
			if (live === undefined) break;

			const age = live - reach;
			if (age < threshold) break;
			// Closed wire groups have no delivery left to wait for. Let their reader
			// finish parsing buffered frames before deciding whether anything is missing.
			if (!first.done && first.consumer.isClosed) break;

			// The budget has run out, and what that costs depends on where the head sits.
			//
			// A finished group the cursor has reached belongs to next(), not to the budget: next()
			// hands over whatever is still queued there and pops the group once it is spent, both
			// within a microtask of being asked. Convicting one either throws away media sitting in
			// memory ready to play, which is what a tune-in burst is, or reports a group the
			// listener has already heard as lost. On legacy audio the second is not even quiet: a
			// frame carries no duration, so a spent group's end reads as its last timestamp and the
			// contiguous successor one frame later is judged a hole, which re-anchors the reader.
			// `rs/moq-mux`'s consumer cannot reach either verdict: its read arm returns a buffered
			// frame, and closes out a spent group as `GroupEnd`, before the budget is consulted.
			if (first.done && cursor !== undefined && first.consumer.sequence <= cursor) break;

			// Above the cursor the group it sits on never arrived, and now it never will. The walk
			// before this loop gives it up first on an ordinary timeline; this one covers a head
			// whose successor starts before it. Give up on those sequences rather than on the media
			// that did arrive: walk the cursor onto the head, the way the same consumer walks onto
			// the first arrived group instead of dropping it. A head that finished holding nothing
			// cannot be walked onto, so it is convicted below along with a head still downloading.
			if (first.done && first.frames.length > 0) {
				// Whether that cost anything is the one thing the reader has to be told: a head
				// that continues the timeline we left off at means the sequence numbers merely
				// jumped, and a head that does not means a span of media is missing.
				if (!ptsContiguous(this.#presentedEnd, first.frames.at(0)?.timestamp)) hole = true;
				this.#active = first.consumer.sequence;
				walked = true;
				break;
			}

			this.#groups.shift();
			this.#active = this.#groups[0]?.consumer.sequence;
			// Everything the verdict was reached on, since the same line has to answer whether the
			// group was actually late or merely long: what it still held, how much of that nobody
			// had read, where delivery stood, whether more was coming, and the three numbers the
			// budget was compared against. Timestamps in microseconds.
			console.warn(
				`skipping slow group: track=${this.#track.name} ${first.consumer.sequence} -> ${this.#active} ` +
					`first=${first.frames.at(0)?.timestamp ?? first.start} last=${first.latest} ` +
					`queued=${first.frames.length} cursor=${cursor} ${first.done ? "closed" : "open"} ` +
					`reach=${reach} live=${live} budget=${threshold}`,
			);

			// Where the timeline picks up is where the next group holding a frame starts, the same
			// bound the verdict was reached on. Anything convicted in between held nothing, and a
			// group that held nothing says nothing about the timeline, so reading the immediate
			// successor here would call a starved group a hole and re-anchor the reader over media
			// that turned out to be contiguous.
			const marker = !first.empty && !first.media;
			if (marker || !ptsContiguous(first.end ?? this.#presentedEnd, reach)) {
				hole = true;
			}
			first.consumer.close();
			first.frames.length = 0;
			skipped = true;
			this.#gap = true;
			// The local half of the same verdict the wire budget reaches, so it lands in the
			// same counter. #tryDurationSkip does not: it only drops a group the next one
			// already covers, so nothing is lost there.
			this.#skipped.set(this.#skipped.peek() + 1);
		}

		if (hole) this.#markPlayhead();

		// A walk moved delivery onto a group already buffered, so the reader has something to read
		// even though nothing was dropped.
		if (skipped || walked) {
			this.#updateBuffered();

			// Wake up any consumers waiting for a new frame.
			this.#notify?.();
			this.#notify = undefined;
		}
	}

	// Skip the stalled active group once it has presented up to where the next group
	// begins (its furthest frame end reaches the next group's first timestamp). Only
	// fires when the active group is fully consumed and still open, so we never drop
	// frames the consumer hasn't seen. Returns true if a group was skipped.
	#tryDurationSkip(): boolean {
		if (this.#active === undefined) return false;

		const active = this.#groups[0];
		if (!active || active.consumer.sequence !== this.#active) return false;
		if (active.done || active.frames.length > 0 || active.end === undefined) return false;

		const next = this.#groups[1];
		const nextStart = next?.frames.at(0)?.timestamp;
		if (!next || nextStart === undefined || active.end < nextStart) return false;

		this.#groups.shift();
		// Debug rather than warn: a live stream crosses one of these at every group boundary, and
		// nothing is lost.
		console.debug(`skipping covered group: ${active.consumer.sequence} -> ${next.consumer.sequence}`);
		this.#recordPresented(active);
		this.#active = next.consumer.sequence;

		active.consumer.close();
		active.frames.length = 0;
		this.#updateBuffered();
		return true;
	}

	// A group whose media timestamps sit below the live edge earlier groups reached is
	// malformed. Returns true if the track was aborted.
	#checkMalformed(): void {
		const live = this.#liveEdge;
		if (live === undefined) return;
		for (const group of this.#groups) {
			if (group.consumer.sequence <= live.group) continue;
			if (group.minMedia !== undefined && group.minMedia < live.timestamp) {
				this.#abort(new Error("group timestamp is below the live edge"));
				return;
			}
		}
	}

	#abortIfRewound(group: Group, timestamp: Time.Micro): boolean {
		const live = this.#liveEdge;
		if (live === undefined) return false;
		if (group.consumer.sequence <= live.group) return false;
		if (timestamp >= live.timestamp) return false;

		this.#abort(new Error("group timestamp is below the live edge"));
		return true;
	}

	#abort(error: Error): void {
		this.#error = error;
		this.#finish(error);
		this.#track.close(error);
		this.#notify?.();
		this.#notify = undefined;
	}

	/**
	 * Returns the next frame in order along with its group number and the current
	 * {@link discontinuity} count, awaiting one if needed. A `frame` of undefined signals either
	 * the end of that group or, when `end` is present, an exclusive media endpoint carried by a
	 * legacy marker. The overall result is undefined once closed. When `discontinuity`
	 * jumps relative to the previous call, re-apply startup delay and skip: it is a playhead
	 * event, not a decoder flush.
	 *
	 * A media-less marker group raises that event on the result that closes it, after its
	 * endpoint and any terminal packets behind it, so the endpoint ends the run it belongs to
	 * rather than trimming the one that resumes.
	 *
	 * `continuous` is true when this result picks up exactly where the previous frame left off, so
	 * the span between them can be treated as delivered. It is false on the first frame, after a
	 * playhead event, and whenever the consumer threw content away to keep up: a slow group skipped
	 * for the max age, a group truncated by a decode error. Use it rather than comparing group
	 * numbers, which are not required to be sequential: adjacency neither proves the timeline is
	 * unbroken nor catches a group dropped on the way past.
	 *
	 * It reports what this consumer dropped plus marker groups the publisher declared.
	 * An unmarked forward timestamp jump still reads as continuous because nothing on the wire says
	 * the missing span will never arrive.
	 * After buffered groups drain, a finished track returns undefined and an aborted track throws.
	 */
	async next(): Promise<
		| {
				frame: Frame | undefined;
				group: number;
				discontinuity: number;
				continuous: boolean;
				end?: Time.Micro;
		  }
		| undefined
	> {
		for (;;) {
			if (this.#error) throw this.#error;
			this.#checkMalformed();
			if (this.#error) throw this.#error;

			const ended = this.#closed.peek();
			if (this.#groups.length === 0) {
				if (ended !== undefined) {
					if (ended instanceof Error) throw ended;
					return undefined;
				}
			}

			// If #active points below all buffered groups -- e.g. the finally block's `+ 1`
			// fallback fired because no later group was buffered yet, and the real (large-gap,
			// non-sequential) next group has since arrived -- promote #active to the first real
			// group so delivery resumes instead of stalling on a nonexistent sequence.
			// Promote #active to the first buffered group when it continues the timeline we left off at,
			// when a completed empty group can be walked (empty groups mean nothing), or when a
			// zero-budget hole is already proven. After track termination no missing group can arrive,
			// so drain across any remaining gap. Otherwise wait: #checkMaxAge skips once the budget
			// is spent, and #tryDurationSkip once the duration covers it.
			if (this.#active !== undefined && this.#groups.length > 0) {
				const head = this.#groups[0];
				if (head.consumer.sequence > this.#active) {
					const contiguous = ptsContiguous(this.#presentedEnd, head.frames.at(0)?.timestamp);
					const empty = head.empty && head.consumer.done;
					const skipHole = this.#maxAge.peek() === 0 && head.frames.length > 0;
					if (empty || contiguous || skipHole || ended !== undefined) {
						if ((skipHole || ended !== undefined) && !contiguous && !empty) this.#markPlayhead();
						if (!contiguous) this.#gap = true;
						this.#active = head.consumer.sequence;
					}
				}
			}

			if (
				this.#groups.length > 0 &&
				this.#active !== undefined &&
				this.#groups[0].consumer.sequence <= this.#active
			) {
				const frame = this.#groups[0].frames.shift();
				if (frame) {
					const seq = this.#groups[0].consumer.sequence;
					const end = this.#format.end?.(frame);
					if (end !== undefined) {
						if (this.#liveEdge === undefined || end > this.#liveEdge.timestamp) {
							this.#liveEdge = { group: seq, timestamp: end };
						}
						this.#updateBuffered();
						return {
							frame: undefined,
							group: seq,
							discontinuity: this.#discontinuity,
							continuous: this.#continuesDelivery(seq),
							end,
						};
					}
					const continuous = this.#continuesDelivery(seq);
					if (seq !== this.#deliveredGroup) this.#gap = false;
					this.#deliveredGroup = seq;

					const live = this.#liveEdge;
					if (live === undefined || frame.timestamp > live.timestamp) {
						this.#liveEdge = { group: seq, timestamp: frame.timestamp };
					}
					this.#updateBuffered();
					return { frame, group: seq, discontinuity: this.#discontinuity, continuous };
				}

				// Check if the group is done and then remove it. A group is removable only
				// once its #runGroup task has finished (done) and all frames are consumed:
				// a below-#active group (a backlog group admitted behind the live edge) may
				// still be downloading when its buffer momentarily drains, and removing it
				// then silently truncates its tail. #runGroup notifies whenever the head
				// group gains a frame, so waiting here is woken, and #checkMaxAge bounds
				// how long a stalled head can hold delivery up.
				if (this.#groups[0].done) {
					if (this.#groups[0].consumer.sequence === this.#active) {
						// The cursor moves past this group here rather than in #runGroup's finally
						// block whenever the group finished before it became active, so this is the
						// site that has to record its presentation end. Advance by +1 and let the
						// promotion guard above resolve the real successor on the next iteration.
						this.#recordPresented(this.#groups[0]);
						this.#active += 1;
					}

					const group = this.#groups.shift();
					if (group) {
						const seq = group.consumer.sequence;
						if (group.truncated) this.#gap = true;
						// A group that carried wire frames but no media is the publisher's declared
						// break. Raised as the group closes rather than on the marker frame, so the
						// endpoint still belongs to the run it ends and the reader only re-anchors
						// once every terminal packet behind the marker has been delivered.
						if (!group.empty && !group.media) this.#markPlayhead();
						this.#updateBuffered();
						return {
							frame: undefined,
							group: seq,
							discontinuity: this.#discontinuity,
							// A marker carries no content of its own, so this just reports whether
							// the group it closes was itself reached without a gap.
							continuous: this.#continuesDelivery(seq),
						};
					}
				}

				// The active group is stalled with nothing buffered. If a later group
				// has already been reached by this group's duration, skip ahead now
				// rather than waiting for the stalled group to resume.
				if (this.#tryDurationSkip()) continue;
			}

			if (this.#notify) {
				throw new Error("multiple calls to next not supported");
			}

			const abort = this.#signals.abort;
			if (abort.aborted) return undefined;

			const aborted = await new Promise<boolean>((resolve) => {
				const onAbort = () => resolve(true);
				abort.addEventListener("abort", onAbort, { once: true });
				this.#notify = () => {
					abort.removeEventListener("abort", onAbort);
					resolve(false);
				};
			});

			this.#notify = undefined;
			if (aborted) return undefined;
		}
	}

	#markPlayhead(): void {
		this.#discontinuity++;
		this.#deliveredGroup = undefined;
		this.#gap = true;
		this.#spread.reanchor();
	}

	#updateBuffered(): void {
		const ranges: BufferedRanges = [];

		let prev: Group | undefined;

		for (const group of this.#groups) {
			const first = group.frames.at(0);
			if (!first || group.latest === undefined) continue;

			const start = Moq.Time.Milli.fromMicro(first.timestamp);
			const end = Moq.Time.Milli.fromMicro(group.latest);

			const last = ranges.at(-1);
			const contiguous = prev?.done && prev.consumer.sequence + 1 === group.consumer.sequence;
			if (last && (last.end >= start || contiguous)) {
				last.end = Moq.Time.Milli.max(last.end, end);
			} else {
				ranges.push({ start, end });
			}

			prev = group;
		}

		this.#buffered.set(ranges);
	}

	/**
	 * A counter that increments at each playhead event: a declared marker group, an unproven
	 * delivered hole, or a latency skip. Also surfaced per-read via {@link next}.
	 */
	get discontinuity(): number {
		return this.#discontinuity;
	}

	/** Stop consuming and release the track and all buffered groups. */
	close(): void {
		this.#finish(null);
		this.#signals.close();
	}
}
