/**
 * Vite config for the audio quality page.
 *
 * `@moq/watch` is consumed here as workspace *source*, not the prebuilt npm package, so its render
 * worklet (`./render-worklet.ts?worklet`) is not pre-inlined; the same plugin `@moq/watch` uses for
 * its own build inlines it as a blob URL here too. That matters more here than elsewhere: a worklet
 * fetched over the network would be a second thing that can stall, inside the measurement.
 *
 * @module
 */
import { defineConfig } from "vite";
import { workletInline } from "../../../../js/common/vite-plugin-worklet";

/** esnext keeps WebCodecs / WebTransport syntax intact for headless Chromium. */
export default defineConfig({
	plugins: [workletInline()],
	build: { target: "esnext", outDir: "dist" },
});
