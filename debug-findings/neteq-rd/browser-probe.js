(async () => {
	if (window.audioProbe) {
		try {
			window.audioProbe.close();
		} catch {
			// The old graph may already be gone.
		}
	}

	const el = window.rdWatch ?? document.querySelector("moq-watch");
	const root = el?.audio?.out.root.peek();
	if (!root) throw new Error("No decoded audio worklet");
	if (root.context.state !== "running") throw new Error("AudioContext is not running");

	const name = "rd-probe-" + Date.now();
	const source = [
		"class Probe extends AudioWorkletProcessor {",
		"  frames = 0; zeros = 0; runs = 0; run = 0; longest = 0; square = 0; peak = 0;",
		"  constructor() {",
		"    super();",
		"    this.port.onmessage = () => this.port.postMessage({",
		"      frames: this.frames, zeros: this.zeros, runs: this.runs,",
		"      longest: this.longest, rms: Math.sqrt(this.square / Math.max(1, this.frames)),",
		"      peak: this.peak, rate: sampleRate",
		"    });",
		"  }",
		"  process(inputs) {",
		"    const data = inputs[0]?.[0];",
		"    if (!data) return true;",
		"    for (const x of data) {",
		"      this.frames++; this.square += x * x; this.peak = Math.max(this.peak, Math.abs(x));",
		"      if (x === 0) {",
		"        this.zeros++; this.run++;",
		"        if (this.run === 16) this.runs++;",
		"        this.longest = Math.max(this.longest, this.run);",
		"      } else this.run = 0;",
		"    }",
		"    return true;",
		"  }",
		"}",
		"registerProcessor(" + JSON.stringify(name) + ", Probe);",
	].join("\n");
	const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
	let moduleTimer;
	try {
		await Promise.race([
			root.context.audioWorklet.addModule(moduleUrl),
			new Promise((_, reject) => {
				moduleTimer = setTimeout(() => reject(new Error("Probe module timeout")), 10_000);
			}),
		]);
	} finally {
		clearTimeout(moduleTimer);
		URL.revokeObjectURL(moduleUrl);
	}

	const probe = new AudioWorkletNode(root.context, name);
	const gain = new GainNode(root.context, { gain: 0 });
	root.connect(probe).connect(gain).connect(root.context.destination);
	let connected = true;
	window.audioProbe = {
		valid: () => connected && root === el.audio.out.root.peek() && root.context.state === "running",
		read: () =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Probe response timeout")), 2_000);
				probe.port.onmessage = (event) => {
					clearTimeout(timer);
					resolve({
						...event.data,
						isolated: crossOriginIsolated,
						delay: el.sync.out.delay.peek(),
						audioTimestamp: el.audio.out.timestamp.peek(),
						videoTimestamp: el.renderer.out.timestamp.peek(),
						decodedVideoTimestamp: el.video.out.timestamp.peek(),
						contextRate: root.context.sampleRate,
						baseLatency: root.context.baseLatency,
						outputLatency: root.context.outputLatency,
						playout: el.audio.out.playout.peek(),
						clock: el.audio.out.clock.peek(),
						target: el.audio.out.target.peek(),
						decodedInput: window.rdDecodedSnapshot?.(),
					});
				};
				probe.port.postMessage("read");
			}),
		close: () => {
			if (!connected) return;
			connected = false;
			root.disconnect(probe);
			probe.disconnect();
			gain.disconnect();
			probe.port.close();
		},
	};
	return { rate: root.context.sampleRate, state: root.context.state, isolated: crossOriginIsolated };
})();
