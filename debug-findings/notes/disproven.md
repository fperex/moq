# Disproven or excluded during this investigation (do not resurrect)

- Opus DTX compressing the timeline: encoder outputs carry the exact input timestamps (784/804
  equal, all deltas 20 ms) and payloads are 64-194 bytes; no time is dropped. (p1-focus-pub)
- "The JS publisher's Opus encoder cannot keep up": true only with Chrome's fake microphone.
  Real USB mic: 1341 in / 1341 out, 0.3 ms encode latency; standalone AudioEncoder: 1000 frames
  in 0.2 s. (p3-real-mic, enc-bench)
- Video encoding starving the audio encoder: audio-only publisher lags identically with the fake
  mic. (p2-audio-only)
- Headless Chrome's audio clock: the AudioWorklet runs at real time in headless (100 quanta per
  267-270 ms); headless was abandoned only because of the fake-mic source. (smoke)
- Relay-side expiry as the local cause: 0 transport stale drops and 0 container skips in every
  local run at every preset; the artifacts are entirely inside the watcher's ring. (e2-bbb-local)
- Network jitter as the local cause: local arrival lateness spread is ~7 ms at p90 and identical
  across presets; only the ring target changes between clean and broken. (e2-bbb-local)
- A "0 ms"/instant setting being what the chip sends: the chip is the RTT-derived auto mode
  (jitter 48.75-57.5 ms on the public relay, 20 ms locally); `instant` disables audio outright.
