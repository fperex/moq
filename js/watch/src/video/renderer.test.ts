import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type * as Catalog from "@moq/hang/catalog";
import { Time } from "@moq/net";
import { Signal } from "@moq/signals";
import type { Decoder } from "./decoder";
import { Renderer } from "./renderer";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await flush();
}

describe("Renderer", () => {
	let callbacks: Map<number, FrameRequestCallback>;
	let nextCallback: number;
	let originalRequest: PropertyDescriptor | undefined;
	let originalCancel: PropertyDescriptor | undefined;

	beforeEach(() => {
		callbacks = new Map();
		nextCallback = 0;
		originalRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
		originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");

		Object.defineProperty(globalThis, "requestAnimationFrame", {
			configurable: true,
			value: (callback: FrameRequestCallback) => {
				const id = ++nextCallback;
				callbacks.set(id, callback);
				return id;
			},
		});
		Object.defineProperty(globalThis, "cancelAnimationFrame", {
			configurable: true,
			value: (id: number) => callbacks.delete(id),
		});
	});

	afterEach(() => {
		if (originalRequest) Object.defineProperty(globalThis, "requestAnimationFrame", originalRequest);
		else Reflect.deleteProperty(globalThis, "requestAnimationFrame");

		if (originalCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
		else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
	});

	function paint(): number {
		const pending = [...callbacks.values()];
		callbacks.clear();
		for (const callback of pending) callback(0);
		return pending.length;
	}

	it("paints the newest frame during an already scheduled display refresh", async () => {
		const drawn: number[] = [];
		const context = {
			canvas: { width: 640, height: 360 },
			save() {},
			restore() {},
			fillRect() {},
			drawImage(frame: VideoFrame) {
				drawn.push(frame.timestamp);
			},
		};
		const canvas = { getContext: () => context } as unknown as HTMLCanvasElement;
		const frame = (timestamp: number) =>
			({
				timestamp,
				clone() {
					return this;
				},
				close() {},
			}) as unknown as VideoFrame;
		const frames = new Signal<VideoFrame | undefined>(frame(1_000));
		const decoder = {
			in: { enabled: new Signal(true) },
			out: { display: new Signal(undefined), frame: frames },
			source: { out: { catalog: new Signal(undefined) } },
		} as unknown as Decoder;
		const renderer = new Renderer({ decoder, canvas, visible: "never" });
		try {
			await settle();
			// Browsers snapshot callback IDs for a refresh. An earlier callback can deliver
			// a new frame before this renderer's callback gets its turn.
			for (const timestamp of [2_000, 3_000, 4_000]) {
				const refresh = [...callbacks.keys()];
				frames.set(frame(timestamp));
				await settle();
				for (const id of refresh) {
					const callback = callbacks.get(id);
					callbacks.delete(id);
					callback?.(0);
				}
			}
			expect(drawn).toEqual([2_000, 3_000, 4_000]);
			expect(renderer.out.timestamp.peek()).toBe(Time.Milli(4));
		} finally {
			renderer.close();
		}
	});

	it("presents adjacent frames across refreshes without retaining an old backlog", async () => {
		const drawn: number[] = [];
		let clones = 0;
		const frame = (timestamp: number, owned = false): VideoFrame => {
			let closed = false;
			if (owned) clones++;
			return {
				timestamp,
				clone() {
					if (closed) throw new Error("cloning a closed frame");
					return frame(timestamp, true);
				},
				close() {
					if (closed) throw new Error("closing a frame twice");
					closed = true;
					if (owned) clones--;
				},
			} as unknown as VideoFrame;
		};
		const context = {
			canvas: { width: 640, height: 360 },
			save() {},
			restore() {},
			fillRect() {},
			drawImage(value: VideoFrame) {
				drawn.push(value.timestamp);
			},
		};
		const frames = new Signal<VideoFrame | undefined>(frame(100_000));
		const decoder = {
			in: { enabled: new Signal(true) },
			out: { display: new Signal(undefined), frame: frames },
			source: { out: { catalog: new Signal(undefined) } },
		} as unknown as Decoder;
		const renderer = new Renderer({
			decoder,
			canvas: { getContext: () => context } as unknown as HTMLCanvasElement,
			visible: "never",
		});
		try {
			await settle();
			paint();
			for (const timestamp of [116_667, 133_333]) {
				frames.set(frame(timestamp));
				await settle();
			}
			paint();
			paint();
			expect(drawn).toEqual([100_000, 116_667, 133_333]);
			for (const timestamp of [150_000, 166_667, 183_333]) {
				frames.set(frame(timestamp));
				await settle();
			}
			paint();
			paint();
			expect(drawn.slice(-2)).toEqual([166_667, 183_333]);
			frames.set(frame(200_000));
			await settle();
			frames.set(frame(333_333));
			await settle();
			paint();
			expect(drawn.at(-1)).toBe(333_333);
			frames.set(frame(350_000));
			await settle();
		} finally {
			renderer.close();
		}
		expect(clones).toBe(0);
	});

	it("repaints the current frame when presentation metadata changes", async () => {
		const transforms: number[][] = [];
		const draws: unknown[][] = [];
		let context: CanvasRenderingContext2D;
		const canvas = {
			width: 640,
			height: 360,
			getContext: () => context,
		} as unknown as HTMLCanvasElement;

		context = {
			canvas,
			fillStyle: "",
			save: () => {},
			restore: () => {},
			fillRect: () => {},
			scale: () => {},
			translate: () => {},
			setTransform: (...matrix: number[]) => transforms.push(matrix),
			drawImage: (...args: unknown[]) => draws.push(args),
		} as unknown as CanvasRenderingContext2D;

		const frame = {
			timestamp: 1_000,
			clone() {
				return this;
			},
			close() {},
		} as unknown as VideoFrame;
		const catalog = new Signal<Catalog.Video | undefined>({ renditions: {}, rotation: 0 });
		const decoder = {
			in: { enabled: new Signal(true) },
			out: {
				display: new Signal({ width: 640, height: 360 }),
				frame: new Signal<VideoFrame | undefined>(frame),
			},
			source: { out: { catalog } },
		} as unknown as Decoder;
		const renderer = new Renderer({ decoder, canvas, visible: "never" });

		try {
			await settle();
			expect(paint()).toBe(1);
			expect(draws).toHaveLength(1);

			catalog.set({ renditions: {}, rotation: 90 });
			await settle();

			expect(paint()).toBe(1);
			expect(draws).toHaveLength(2);
			expect(transforms.at(-1)).toEqual([0, 1, -1, 0, 640, 0]);
			expect(draws.at(-1)?.slice(1)).toEqual([0, 0, 360, 640]);
		} finally {
			renderer.close();
		}
	});
});
