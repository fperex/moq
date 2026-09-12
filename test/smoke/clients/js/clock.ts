/** Isolate the browser's render clock from MoQ and PCM playout. */
import { parseArgs } from "node:util";
import { launch } from "./harness";

const { values } = parseArgs({ options: { mode: { type: "string" }, seconds: { type: "string" } } });
const modes = ["static", "graph", "suspend"];
if (values.mode && !modes.includes(values.mode)) throw new Error("invalid --mode");
const seconds = Number(values.seconds ?? 10);
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) throw new Error("invalid --seconds");

const processor = `
class ClockProbe extends AudioWorkletProcessor {
  previous;
  calls = 0;
  anomalies = [];
  duplicates = 0;
  forwardGaps = 0;
  process(inputs, outputs) {
    const quantum = outputs[0][0].length;
    if (this.previous !== undefined && currentFrame !== this.previous + quantum) {
      const observation = {frame: currentFrame, previous: this.previous, quantum, time: currentTime, call: this.calls};
      if (currentFrame < this.previous + quantum) this.duplicates++;
      else this.forwardGaps++;
      if (this.anomalies.length < 16) this.anomalies.push(observation);
    }
    this.previous = currentFrame;
    this.calls++;
    return true;
  }
  constructor() {
    super();
    this.port.onmessage = () => this.port.postMessage({calls: this.calls, duplicates: this.duplicates, forwardGaps: this.forwardGaps, anomalies: this.anomalies});
  }
}
registerProcessor('clock-probe', ClockProbe);
`;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response("<button>Start clock probe</button>", { headers: { "Content-Type": "text/html" } }),
});
const browser = await launch();
try {
	console.log(JSON.stringify({ browser: browser.version(), seconds, productionImports: false }));
	for (const mode of modes) {
		if (values.mode && values.mode !== mode) continue;
		const page = await browser.newPage();
		try {
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.evaluate(
				({ processor, seconds, mode }) => {
					const button = document.querySelector("button");
					if (!button) throw new Error("missing start button");
					button.onclick = async () => {
						const context = new AudioContext({ sampleRate: 48000 });
						try {
							await context.audioWorklet.addModule(
								URL.createObjectURL(new Blob([processor], { type: "text/javascript" })),
							);
							const node = new AudioWorkletNode(context, "clock-probe", {
								numberOfInputs: 0,
								outputChannelCount: [2],
							});
							node.connect(context.destination);
							await context.resume();
							let mutations = 0;
							let cycles = 0;
							const until = performance.now() + seconds * 1000;
							while (performance.now() < until) {
								if (mode === "graph") {
									for (let i = 0; i < 100; i++) {
										const gain = context.createGain();
										node.connect(gain);
										gain.connect(context.destination);
										node.disconnect(gain);
										gain.disconnect();
										mutations++;
									}
								} else if (mode === "suspend") {
									await context.suspend();
									await context.resume();
									cycles++;
								}
								await new Promise((resolve) => setTimeout(resolve, mode === "static" ? 100 : 4));
							}
							const observation = await new Promise<unknown>((resolve) => {
								node.port.onmessage = (event) => resolve(event.data);
								node.port.postMessage("snapshot");
							});
							document.body.dataset.result = JSON.stringify({ mode, mutations, cycles, observation });
						} catch (error) {
							document.body.dataset.error = String(error);
						} finally {
							await context.close();
						}
					};
				},
				{ processor, seconds, mode },
			);
			await page.click("button");
			await page.waitForFunction(
				() => document.body.dataset.result !== undefined || document.body.dataset.error !== undefined,
				undefined,
				{
					timeout: seconds * 1000 + 15000,
				},
			);
			const error = await page.evaluate(() => document.body.dataset.error);
			if (error) throw new Error(error);
			console.log(await page.evaluate(() => document.body.dataset.result));
		} finally {
			await page.close();
		}
	}
} finally {
	await browser.close();
	server.stop(true);
}
