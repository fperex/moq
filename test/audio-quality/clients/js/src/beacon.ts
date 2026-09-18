/**
 * Ships the probe's samples to the sink, in batches, and gets the last one out on the way down.
 *
 * A run's most interesting seconds are often its last, and a page that is closing cannot wait for a
 * `fetch` to resolve. `sendBeacon` on `pagehide` is the browser's answer: the request is handed to
 * the network stack and survives the document. So the steady state is a batched POST and the final
 * flush is a beacon, and the sink appends either one the same way.
 *
 * Adapted from the beacon sink in `debug-findings/analysis/sink.ts` on the reporter's fork
 * (`fperex/moq`, branch `debug/rt-audio`). See ../../README.md.
 *
 * @module
 */
import type { Beacon, Environment, Sample } from "./schema.ts";

/** How often a batch is posted. Small enough that a crash loses little, large enough to be cheap. */
const FLUSH_INTERVAL_MS = 1000;

/** What to report and where. */
export type BeaconProps = {
	/** The sink's `/log` endpoint. */
	url: string;
	/** The row this page is playing; the sink files batches under it. */
	tag: string;
	/** Take everything sampled since the last call. */
	drain: () => Sample[];
	/**
	 * What the page is, once it knows. Null until the session is up.
	 *
	 * Sent on the first batch that can report it, and not again: it carries the connection's
	 * round-trip time, which moves constantly, so re-sending it on a change would be re-sending it
	 * every batch. Anything not settled by the time the catalog arrives is a {@link Sample} field.
	 */
	environment: () => Environment | null;
	/** Console warnings and errors so far. */
	notes: () => string[];
};

/** Start shipping. The returned function flushes once more and stops. */
export function beacon(props: BeaconProps): () => void {
	let sentEnvironment = false;
	let sentFinal = false;

	const batch = (final: boolean): Beacon | undefined => {
		const samples = props.drain();
		const environment = sentEnvironment ? undefined : (props.environment() ?? undefined);
		if (environment) sentEnvironment = true;
		// A batch with nothing new in it is not worth a request, but the last one always goes: it is
		// what tells the sink the row ended rather than the page having died mid-run.
		if (!final && samples.length === 0 && !environment) return undefined;
		return { tag: props.tag, environment, samples, notes: final ? props.notes() : undefined };
	};

	const post = (final: boolean) => {
		// The final batch is what tells the sink the row ended, so it goes exactly once however
		// the page got here: `pagehide` and the returned stop function both arrive in a normal run.
		if (final) {
			if (sentFinal) return;
			sentFinal = true;
		}
		const body = batch(final);
		if (!body) return;
		const text = JSON.stringify(body);
		if (final && navigator.sendBeacon) {
			// A Blob rather than a string, so the type is text/plain and the request stays a simple
			// one: a preflight cannot be answered once the document is gone.
			//
			// sendBeacon refuses rather than throws when the payload is too large or the queue is
			// full, and a dropped final batch reads downstream as a page that died mid-run, so a
			// refusal falls through to fetch instead.
			if (navigator.sendBeacon(props.url, new Blob([text], { type: "text/plain" }))) return;
		}
		void fetch(props.url, { method: "POST", body: text, keepalive: final }).catch(() => {});
	};

	const timer = setInterval(() => post(false), FLUSH_INTERVAL_MS);
	const onHide = () => post(true);
	addEventListener("pagehide", onHide);

	return () => {
		clearInterval(timer);
		removeEventListener("pagehide", onHide);
		post(true);
	};
}
