import { type Effect, Signal } from "@moq/signals";

/**
 * A budget for re-opening a `getUserMedia` capture that failed or died.
 *
 * A `MediaStreamTrack` ends when the device disappears, the OS revokes it, or another application
 * takes an exclusive device, and the reopen that follows can itself fail. Both spend budget, so a
 * device that never works stops being asked. A device that is merely busy is not one of those: see
 * {@link BUSY}.
 *
 * Every outcome reruns the owning effect, including running out of budget. That rerun is what clears
 * `out.source` and stops the stream, via the cleanup the previous run registered, so no caller has to
 * remember to. Screen capture cannot use this: `getDisplayMedia` needs a user gesture to reopen.
 */
export class Retry {
	/** Consecutive failures tolerated before the capture is left alone. */
	static readonly LIMIT = 3;

	/** How long a track has to survive before earlier failures stop counting against it. */
	static readonly SETTLED = 5000;

	/**
	 * Escalating pause between attempts, so a device mid-re-enumerate gets a moment rather than
	 * being asked three more times in the same millisecond.
	 *
	 * No give-up deadline: {@link LIMIT} is this budget, counted in attempts. Counting time instead
	 * would make the outcome depend on how long the OS takes to say no.
	 */
	static readonly DELAY = { initial: 250, multiplier: 2, max: 1000 };

	/**
	 * The `getUserMedia` failures that mean "not right now" rather than "no".
	 *
	 * The device is there and we are allowed to use it, something else is holding it: another
	 * application, or the capture we ourselves just stopped, since a browser hands the device back
	 * to the OS some time after `stop()` returns. Spending budget on that window is how hiding
	 * video and showing it again leaves the camera dark for good, so these wait out the backoff
	 * without spending any. The wait is bounded by the caller's intent: switching the source off
	 * ends it.
	 */
	static readonly BUSY = ["NotReadableError", "AbortError"];

	readonly #rerun = new Signal(0);

	// Where to report why the capture is not running, so the owner can publish it as its own output.
	readonly #error: Signal<Error | undefined>;

	// Deliberately plain fields: effect reruns must not unwind them, or the budget never runs out.
	#failures = 0;
	#settings: unknown[] | undefined;
	#delay = Retry.DELAY.initial;

	// How long the next attempt still owes the backoff, set by `failed` and paid by `begin`.
	#wait: DOMHighResTimeStamp | undefined;

	/** Reports why the capture is not running into `error`, and clears it once it is. */
	constructor(error: Signal<Error | undefined>) {
		this.#error = error;
	}

	/**
	 * Subscribe the capture effect and report whether an attempt is worth making right now.
	 *
	 * False means don't capture on this run: either the budget is spent, or the backoff from the
	 * last failure hasn't elapsed and a rerun is already scheduled for when it has. Return from the
	 * run either way, and the previous run's cleanup clears whatever it published. Splitting it like
	 * this is what lets a dead track be dropped immediately while the *reopen* still waits.
	 *
	 * The budget belongs to `settings`, the caller's live capture settings. Changing any of them is
	 * new intent rather than another go at the same thing, so it starts a fresh budget: picking a
	 * different device, or fixing a constraint no device could satisfy, revives a spent capture.
	 */
	begin(effect: Effect, settings: unknown[]): boolean {
		effect.get(this.#rerun);

		if (settings.some((setting, i) => setting !== this.#settings?.[i])) {
			this.#settings = settings;
			this.#clear();
		}

		if (this.#failures > Retry.LIMIT) return false;

		const wait = this.#wait;
		if (wait !== undefined) {
			this.#wait = undefined;
			effect.timer(() => this.#rerun.update((rerun) => rerun + 1), wait);
			return false;
		}

		return true;
	}

	/**
	 * The attempt produced no usable track. Reruns the effect, spending budget unless the device was
	 * merely {@link BUSY}.
	 *
	 * `reason` is what the browser said, kept so the capture can report why it is dark instead of
	 * leaving a black canvas to speak for it.
	 */
	failed(reason?: unknown): void {
		const error = asError(reason);

		// The same refusal repeating is one refusal. A busy device says it once a second for as
		// long as it is busy, and every consumer would relight on each one.
		if (this.#error.peek()?.message !== error.message) this.#error.set(error);

		if (!Retry.BUSY.includes(error.name)) this.#failures += 1;

		// Unlimited budget, so there is always a next delay.
		// Equal jitter, so a page with several captures doesn't reopen them all on the same tick.
		this.#wait = this.#delay * (0.5 + Math.random() / 2);
		this.#delay = Math.min(this.#delay * Retry.DELAY.multiplier, Retry.DELAY.max);
		this.#rerun.update((rerun) => rerun + 1);
	}

	/** The attempt produced a live track. Reruns the effect if it dies. */
	succeeded(effect: Effect, track: MediaStreamTrack): void {
		this.#error.set(undefined);

		effect.timer(() => {
			this.#clear();
		}, Retry.SETTLED);

		effect.event(track, "ended", () => this.failed(new Error("the capture device stopped")));
	}

	/** Refund the budget, because something changed that makes another attempt worth trying. */
	refund(): void {
		if (this.#failures === 0 && this.#wait === undefined) return;

		this.#clear();
		this.#rerun.update((rerun) => rerun + 1);
	}

	/** Forget the failures so far, along with the pause they earned. */
	#clear(): void {
		this.#failures = 0;
		this.#wait = undefined;
		this.#delay = Retry.DELAY.initial;
		this.#error.set(undefined);
	}
}

// What a capture rejected with, as an Error carrying the browser's name for it.
//
// getUserMedia rejects with a DOMException, which is not an Error everywhere, and with a plain
// OverconstrainedError object in Firefox, so the name is read off the value rather than its type.
function asError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason !== "object" || reason === null) return new Error("the capture produced no track");

	const named = reason as { name?: unknown; message?: unknown };
	const error = new Error(typeof named.message === "string" ? named.message : String(reason));
	if (typeof named.name === "string") error.name = named.name;
	return error;
}
