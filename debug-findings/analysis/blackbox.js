// Black-box playout probe for ANY <moq-watch> build (published package or source): reads only the
// public element API. Injected by run.mjs through CDP Runtime.evaluate once the element exists.
// Playhead: audio.out.timestamp sampled every 50 ms; a plateau while not stalled is an underrun,
// an advance larger than elapsed + 15 ms is a skip. PCM: an AnalyserNode on audio.out.root (fan-out,
// re-attached when the node changes) reports the share of 50 ms windows below -60 dBFS.
(() => {
	const el = document.querySelector("moq-watch");
	if (!el) return "no moq-watch";
	const peek = (s) => (s && typeof s.peek === "function" ? s.peek() : undefined);
	const bb = {
		t0: performance.now(),
		samples: 0,
		plateaus: 0,
		plateauMs: 0,
		skips: 0,
		skipMs: 0,
		stalledSamples: 0,
		silentWindows: 0,
		pcmWindows: 0,
		lastTs: undefined,
		lastWall: undefined,
		inPlateau: false,
		plateauStart: 0,
		analyser: undefined,
		buf: undefined,
		attachedTo: undefined,
	};
	const attach = () => {
		const root = peek(el.audio?.out?.root);
		if (!root || root === bb.attachedTo) return;
		try {
			const analyser = new AnalyserNode(root.context, { fftSize: 2048 });
			root.connect(analyser);
			bb.analyser = analyser;
			bb.buf = new Float32Array(analyser.fftSize);
			bb.attachedTo = root;
		} catch {}
	};
	const tick = () => {
		attach();
		const wall = performance.now();
		const ts = peek(el.audio?.out?.timestamp);
		const stalled = peek(el.audio?.out?.stalled);
		bb.samples++;
		if (stalled) bb.stalledSamples++;
		if (typeof ts === "number" && typeof bb.lastTs === "number" && !stalled) {
			const dts = ts - bb.lastTs;
			const dwall = wall - bb.lastWall;
			if (dts <= 0) {
				if (!bb.inPlateau) {
					bb.inPlateau = true;
					bb.plateaus++;
					bb.plateauStart = wall;
				}
			} else {
				if (bb.inPlateau) {
					bb.inPlateau = false;
					bb.plateauMs += wall - bb.plateauStart;
				}
				if (dts > dwall + 15) {
					bb.skips++;
					bb.skipMs += dts - dwall;
				}
			}
		}
		bb.lastTs = ts;
		bb.lastWall = wall;
		if (bb.analyser && bb.buf) {
			bb.analyser.getFloatTimeDomainData(bb.buf);
			let sum = 0;
			for (let i = 0; i < bb.buf.length; i++) sum += bb.buf[i] * bb.buf[i];
			const rms = Math.sqrt(sum / bb.buf.length);
			bb.pcmWindows++;
			if (rms < 0.001) bb.silentWindows++;
		}
	};
	const iv = setInterval(tick, 50);
	window.__bb = {
		stop: () => clearInterval(iv),
		summary: () => {
			const minutes = (performance.now() - bb.t0) / 60000;
			const sync = el.sync?.out ?? {};
			return {
				seconds: Math.round((performance.now() - bb.t0) / 100) / 10,
				plateausPerMin: Math.round(bb.plateaus / minutes),
				plateauMsPerMin: Math.round(bb.plateauMs / minutes),
				skipsPerMin: Math.round(bb.skips / minutes),
				skipMsPerMin: Math.round(bb.skipMs / minutes),
				stalledPct: Math.round((1000 * bb.stalledSamples) / Math.max(1, bb.samples)) / 10,
				silentPct: bb.pcmWindows ? Math.round((1000 * bb.silentWindows) / bb.pcmWindows) / 10 : null,
				delay: peek(sync.delay) ?? peek(sync.buffer),
				jitter: peek(sync.jitter),
				maxAge: peek(sync.maxAge) ?? peek(sync.maxBuffer),
				rtt: peek(el.connection?.probe)?.rtt,
				isolated: globalThis.crossOriginIsolated === true,
				latencyAttr: el.getAttribute("latency"),
				delayAttr: el.getAttribute("delay"),
			};
		},
	};
	return "installed";
})();
