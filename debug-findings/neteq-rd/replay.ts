import { Time } from '../../js/net/src/index.ts';
import { AudioRingBuffer } from './baseline/ring-buffer.ts';
import { allocSharedRingBuffer, SharedRingBuffer } from './baseline/shared-ring-buffer.ts';

const seconds = 30;
const results = [];
for (const rate of [44100, 48000]) {
  for (const chunk of [Math.round(rate / 50), 1024]) {
    for (const scenario of [{jitter: 0, burst: 1, drift: 0}, {jitter: 12, burst: 1, drift: 0}, {jitter: 12, burst: 2, drift: 0}, {jitter: 20, burst: 7, drift: 0}, {jitter: 0, burst: 1, drift: 0.002}, {jitter: 0, burst: 1, drift: -0.002}]) {
      const {jitter, burst, drift} = scenario;
      for (const mode of ['post', 'shared']) {
        const target = 43;
        const ring = mode === 'post'
          ? new AudioRingBuffer({rate, channels: 1, latency: Time.Milli(target)})
          : new SharedRingBuffer(allocSharedRingBuffer(1, rate, rate));
        if (ring instanceof SharedRingBuffer) ring.setLatency(Math.ceil(rate * target / 1000));
        const output = [new Float32Array(128)];
        let inserted = 0;
        let last = 0;
        let missing = 0;
        let shortfall = 0;
        let backwards = 0;
        let firstPlaybackMs: number | undefined;
        for (let tick = 0; tick * 128 < rate * seconds; tick++) {
          const now = tick * 128 * 1000 / rate;
          for (;;) {
            const frame = inserted / chunk;
            const arrival = (Math.floor(frame / burst) * burst + burst - 1) * chunk * 1000 / rate / (1 + drift) + (Math.floor(frame / burst) % 2 ? jitter : 0);
            if (arrival > now) break;
            const pcm = [Float32Array.from({length: chunk}, (_, i) => inserted + i + 1)];
            const timestamp = Time.Micro(Math.round(inserted * 1e6 / rate));
            if (ring instanceof SharedRingBuffer) ring.insert(timestamp, pcm);
            else ring.write(timestamp, pcm);
            inserted += chunk;
          }
          output[0].fill(0);
          const got = ring.read(output);
          if (got && firstPlaybackMs === undefined) firstPlaybackMs = now;
          if (now < 1000) { if (got) last = output[0][got - 1]; continue; }
          shortfall += 128 - got;
          for (let i = 0; i < got; i++) {
            const sample = output[0][i];
            if (sample > last + 1) missing += sample - last - 1;
            if (sample <= last) backwards++;
            last = sample;
          }
        }
        results.push({rate, chunk, jitterMs: jitter, burst, drift, mode, firstPlaybackMs,
          missingMs: missing * 1000 / rate, shortfallMs: shortfall * 1000 / rate, backwards});
      }
    }
  }
}
console.log(JSON.stringify({seconds, warmupSeconds: 1, results}, null, 2));
