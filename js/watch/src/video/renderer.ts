import type * as Catalog from "@moq/hang/catalog";
import { Time } from "@moq/net";
import { Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";
import type { Decoder } from "./decoder";
import { canvasPresentationTransform } from "./presentation";

// Fraction of the canvas that must intersect the viewport before it counts as visible.
const INTERSECTION_THRESHOLD = 0.01;

/**
 * Controls when video is downloaded relative to the canvas position.
 *
 * - `"never"`: never download video.
 * - `"always"`: always download video, regardless of the canvas position or tab visibility.
 * - a CSS length (`"0px"`, `"200px"`, `"100%"`, ...): download while the canvas is within
 *   that distance of the viewport (used as the {@link IntersectionObserver} `rootMargin`) and
 *   the tab is visible. `"0px"` means strictly on screen; larger values pre-warm the video
 *   before it scrolls in.
 */
export type Visible = "never" | "always" | (string & {});

export type RendererInput = {
	canvas: Getter<HTMLCanvasElement | undefined>;

	// When video is downloaded relative to the canvas position. See {@link Visible}. Defaults to "20%".
	visible: Getter<Visible>;
};

/** Constructor properties for {@link Renderer}. */
export type RendererProps = Inputs<RendererInput> & {
	/** Decoder supplying video frames. */
	decoder: Decoder;
};

type RendererOutput = {
	// The most recently rendered frame, updated after each rAF paint.
	frame: Signal<VideoFrame | undefined>;

	// The media timestamp of the most recently rendered frame.
	timestamp: Signal<Time.Milli | undefined>;

	// Whether the canvas should currently download per the configured distance and tab focus.
	// The owner combines this with `paused` to drive the decoder's `enabled` input.
	visible: Signal<boolean>;
};

// An component to render a video to a canvas.
export class Renderer {
	readonly decoder: Decoder;

	readonly in: Readonlys<RendererInput>;

	readonly #out: RendererOutput = {
		frame: new Signal<VideoFrame | undefined>(undefined),
		timestamp: new Signal<Time.Milli | undefined>(undefined),
		visible: new Signal(false),
	};
	readonly out = readonlys(this.#out);

	#ctx = new Signal<CanvasRenderingContext2D | undefined>(undefined);
	#signals = new Effect();

	constructor(props: RendererProps) {
		this.decoder = props.decoder;
		this.in = {
			canvas: getter(props?.canvas),
			visible: getter(props?.visible ?? "20%"),
		};

		this.#signals.run((effect) => {
			const canvas = effect.get(this.in.canvas);
			this.#ctx.set(canvas?.getContext("2d") ?? undefined);
		});

		this.#signals.run(this.#runVisible.bind(this));
		this.#signals.run(this.#runRender.bind(this));
		this.#signals.run(this.#runResize.bind(this));
	}

	#runResize(effect: Effect) {
		const values = effect.getAll([this.in.canvas, this.decoder.out.display]);
		if (!values) return; // Keep current canvas size until we have new dimensions
		const [canvas, display] = values;

		// Only update if dimensions actually changed (setting canvas.width/height clears the canvas)
		// TODO I thought the signals library would prevent this, but I'm too lazy to investigate.
		if (canvas.width !== display.width || canvas.height !== display.height) {
			canvas.width = display.width;
			canvas.height = display.height;
		}
	}

	// Track whether the canvas should currently download per the configured distance and tab focus.
	#runVisible(effect: Effect): void {
		const visible = effect.get(this.in.visible);

		// "never" forces the check off; "always" forces it on regardless of viewport or tab state.
		if (visible === "never") {
			this.#out.visible.set(false);
			return;
		}

		if (visible === "always") {
			this.#out.visible.set(true);
			effect.cleanup(() => this.#out.visible.set(false));
			return;
		}

		// A distance gates on the viewport (used as the rootMargin) and the tab being visible.
		const canvas = effect.get(this.in.canvas);
		if (!canvas) {
			this.#out.visible.set(false);
			return;
		}

		let intersecting = false;
		const update = () => {
			this.#out.visible.set(intersecting && !document.hidden);
		};

		const callback = (entries: IntersectionObserverEntry[]) => {
			for (const entry of entries) {
				intersecting = entry.isIntersecting;
				update();
			}
		};

		// `visible` is a CSS length, but the programmatic API accepts arbitrary strings. An
		// invalid rootMargin throws a SyntaxError, so fall back to the default margin.
		let observer: IntersectionObserver;
		try {
			observer = new IntersectionObserver(callback, { threshold: INTERSECTION_THRESHOLD, rootMargin: visible });
		} catch {
			console.warn(`moq-watch: invalid visible margin "${visible}", using "0px"`);
			observer = new IntersectionObserver(callback, { threshold: INTERSECTION_THRESHOLD });
		}

		update();
		effect.event(document, "visibilitychange", update);
		observer.observe(canvas);
		effect.cleanup(() => observer.disconnect());
		effect.cleanup(() => this.#out.visible.set(false));
	}

	#runRender(effect: Effect) {
		const ctx = effect.get(this.#ctx);
		if (!ctx) return;

		let animate: number | undefined;
		let dirty = false;
		let source: VideoFrame | undefined;
		const frames: VideoFrame[] = [];
		// The display's refresh interval, measured from rAF timestamps (60Hz until measured), and
		// whether the last refresh left a frame queued. A pair released inside one refresh is shown
		// over two; a queue that is still non-empty a refresh later is a standing lag, so it drains.
		let refresh = 1000 / 60;
		let last: number | undefined;
		let carried = false;
		const clear = () => {
			for (const frame of frames) frame.close();
			frames.length = 0;
			carried = false;
		};
		const render = (now?: number) => {
			animate = undefined;
			if (now !== undefined && last !== undefined) {
				const delta = now - last;
				if (delta > 0 && delta < 100) refresh = delta;
			}
			if (now !== undefined) last = now;
			if (carried && frames.length > 1) {
				while (frames.length > 1) frames.shift()?.close();
			}
			if (dirty || frames.length) {
				dirty = false;
				const pending = frames.shift();
				carried = frames.length > 0;
				const frame = pending ?? (source ? this.#out.frame.peek() : undefined);
				const video = this.decoder.source.out.catalog.peek();
				try {
					this.#render(ctx, frame, video);
					const retained = frame?.clone();
					this.#out.frame.update((current) => {
						current?.close();
						return retained;
					});
					this.#out.timestamp.set(frame ? Time.Milli.fromMicro(frame.timestamp as Time.Micro) : undefined);
				} finally {
					pending?.close();
				}
			}
			// Keep a place in every display refresh while playing. Rescheduling from a
			// frame update during that refresh would miss its already-snapshotted callbacks.
			if (this.decoder.in.enabled.peek()) animate = requestAnimationFrame(render);
		};
		effect.run((inner) => {
			const frame = inner.get(this.decoder.out.frame);
			inner.get(this.decoder.source.out.catalog);
			const enabled = inner.get(this.decoder.in.enabled);
			const reset = !enabled || !this.#out.frame.peek() || !frame;
			if (reset) clear();
			if (frame && (frame !== source || reset)) {
				frames.push(frame.clone());
				// Timers can release adjacent frames on opposite sides of a display refresh.
				// Preserve that pair, but never turn it into a stale presentation backlog. Adjacent
				// is sized from the display, not a fixed 20ms of media: two refreshes' worth keeps a
				// 30fps pair on a 60Hz display.
				const adjacent = Math.max(20_000, 2.1 * refresh * 1000);
				while (frames.length > 2 || (frames[0] && frame.timestamp - frames[0].timestamp > adjacent)) {
					frames.shift()?.close();
				}
			}
			source = frame;
			dirty = true;
			// A paused tile still paints changed metadata or its final frame once.
			if (animate === undefined) animate = requestAnimationFrame(render);
		});

		// Clean up any pending animation request.
		effect.cleanup(() => {
			if (animate !== undefined) cancelAnimationFrame(animate);
			clear();
		});
	}

	#render(ctx: CanvasRenderingContext2D, frame?: VideoFrame, video?: Catalog.Video) {
		if (!frame) {
			// Clear canvas when no frame
			ctx.fillStyle = "#000";
			ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
			return;
		}

		// Prepare background and transformations for this draw
		ctx.save();
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

		// Apply rotation and horizontal flip from the video config.
		if (!video?.rotation) {
			if (video?.flip) {
				ctx.scale(-1, 1);
				ctx.translate(-ctx.canvas.width, 0);
			}
			ctx.drawImage(frame, 0, 0, ctx.canvas.width, ctx.canvas.height);
		} else {
			const transform = canvasPresentationTransform(ctx.canvas, video);
			ctx.setTransform(...transform.matrix);
			ctx.drawImage(frame, 0, 0, transform.source.width, transform.source.height);
		}
		ctx.restore();
	}

	// Close the track and all associated resources.
	close() {
		this.#out.frame.update((current) => {
			current?.close();
			return undefined;
		});
		this.#out.timestamp.set(undefined);
		this.#signals.close();
	}
}
