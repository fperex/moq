/**
 * The page's one audio worker, shared by every player that hands it its audio.
 *
 * @module
 */

import { Time } from "@moq/net";
import { Effect } from "@moq/signals";
import { type FromWorker, type Handle, spawn, type ToWorker } from "./protocol";

/**
 * How long the page keeps a worker nobody holds, so a tile torn down and built again elsewhere on the
 * page gets the one it had, and the sessions that worker already holds. `@moq/net`'s connection pool
 * lingers as long, for the same reason.
 */
export const LINGER = Time.Milli(2_000);

/** A message about one player. */
export type PlayerMessage = Extract<ToWorker, { id: number }>;

/** One player's hold on the page's worker. */
export interface Lease {
	/** The player's id in every message it and the worker exchange about it. */
	readonly id: number;

	/** Resolves once the worker is ready, with undefined, or with why this page cannot use one. */
	readonly ready: Promise<string | undefined>;

	/** What the worker says about this player, and what it says about itself (an `error` with no `id`). */
	onmessage: ((msg: FromWorker) => void) | undefined;

	/** Post a message about this player. Throws before the worker is ready; does nothing once released. */
	post(msg: PlayerMessage, transfer?: Transferable[]): void;

	/** Tell the worker this player is gone and let go of the worker. Idempotent. */
	release(): void;
}

// One worker and the players holding it.
interface Entry {
	handle?: Handle;
	leases: Map<number, Hold>;
	timer?: ReturnType<typeof setTimeout>;
	// Set once the linger ran out, so a worker still on its way is terminated when it arrives.
	abandoned: boolean;
}

// A lease and the way to settle its `ready`.
interface Hold {
	lease: Lease;
	settle: (reason: string | undefined) => void;
}

/**
 * Spawns the page's audio worker for its first player and keeps it for as long as any player holds it,
 * plus {@link LINGER}.
 *
 * A worker the page could not start is remembered for the document's life: whatever refused it (a CSP,
 * a worker without a decoder) refuses the next one too, so every later player falls back at once
 * rather than paying for another attempt.
 *
 * Forwards the page being put away and coming back to the worker, which has no window to hear it from
 * (see `suspend` in `protocol.ts`), exactly as `@moq/net`'s reconnect loop hears it.
 */
export class Pool {
	readonly #create: () => Worker | Promise<Worker>;
	#entry?: Entry;
	#refused?: string;
	#suspended = false;
	#next = 0;
	#signals = new Effect();

	/** `create` makes the worker: the bundled one on the page, a stand-in in a test. */
	constructor(create: () => Worker | Promise<Worker>) {
		this.#create = create;

		const win = globalThis.window;
		const doc = globalThis.document;
		if (typeof win !== "undefined" && typeof doc !== "undefined") {
			this.#signals.event(win, "pagehide", () => this.#suspend(true));
			this.#signals.event(win, "pageshow", () => this.#suspend(false));
			this.#signals.event(win, "unload", () => this.#suspend(true));
			this.#signals.event(doc, "visibilitychange", () => {
				if (!doc.hidden) this.#suspend(false);
			});
		}
	}

	/** Hold the page's worker for one player, starting it if nobody does. */
	acquire(): Lease {
		const id = ++this.#next;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let released = false;
		let ready = false;

		const refused = this.#refused;
		if (refused !== undefined) {
			resolve(refused);
			return {
				id,
				ready: promise,
				onmessage: undefined,
				post: () => {
					throw new Error("posted to a worker the page could not start");
				},
				release: () => {},
			};
		}

		const entry = this.#entry ?? this.#start();
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}

		const lease: Lease = {
			id,
			ready: promise,
			onmessage: undefined,
			post: (msg, transfer) => {
				if (released) return;
				if (!ready || !entry.handle) throw new Error("posted before the worker was ready");
				if (msg.id !== id) throw new Error(`player ${id} posted about player ${msg.id}`);
				entry.handle.post(msg, transfer);
			},
			release: () => {
				if (released) return;
				released = true;
				entry.leases.delete(id);
				if (ready) entry.handle?.post({ type: "close", id });
				else resolve("the player let go before the worker was ready");
				if (entry.leases.size === 0 && this.#entry === entry) this.#linger(entry);
			},
		};

		entry.leases.set(id, {
			lease,
			settle: (reason) => {
				ready = reason === undefined;
				resolve(reason);
			},
		});

		// Already running: ready as soon as the caller can hear it.
		if (entry.handle) entry.leases.get(id)?.settle(undefined);

		return lease;
	}

	#start(): Entry {
		const entry: Entry = { leases: new Map(), abandoned: false };
		this.#entry = entry;

		void spawn(this.#create).then((spawned) => {
			if ("reason" in spawned) {
				this.#refused = spawned.reason;
				if (this.#entry === entry) this.#entry = undefined;
				for (const hold of entry.leases.values()) hold.settle(spawned.reason);
				return;
			}

			const handle = spawned.handle;
			if (entry.abandoned) {
				handle.close();
				return;
			}

			entry.handle = handle;
			handle.onmessage = (msg) => this.#route(entry, msg);
			if (this.#suspended) handle.post({ type: "suspend", suspended: true });
			for (const hold of entry.leases.values()) hold.settle(undefined);
		});

		return entry;
	}

	// A player's messages to that player; the worker's own trouble to every player.
	#route(entry: Entry, msg: FromWorker): void {
		const id = "id" in msg ? msg.id : undefined;
		if (id !== undefined) {
			entry.leases.get(id)?.lease.onmessage?.(msg);
			return;
		}
		for (const hold of [...entry.leases.values()]) hold.lease.onmessage?.(msg);
	}

	#linger(entry: Entry): void {
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			entry.abandoned = true;
			if (this.#entry === entry) this.#entry = undefined;
			entry.handle?.close();
		}, LINGER);
	}

	#suspend(suspended: boolean): void {
		if (suspended === this.#suspended) return;
		this.#suspended = suspended;
		this.#entry?.handle?.post({ type: "suspend", suspended });
	}

	/** Terminate the worker now and stop listening to the page. */
	close(): void {
		this.#signals.close();
		const entry = this.#entry;
		this.#entry = undefined;
		if (!entry) return;
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.abandoned = true;
		entry.handle?.close();
	}
}
