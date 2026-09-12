# Why the adaptive target still misses rare arrival tails

The current branch estimates delay from decoded PCM availability in [`Playout.#observe`](../../js/watch/src/audio/playout.ts#L829). The estimator keeps the maximum relative delay from each 500 ms interval. It decays the interval histogram by 0.983 and selects its 95th percentile. A 2 second rolling minimum removes the arrival-clock offset and short-term baseline delay.

This design preserves short spikes within an interval because the histogram receives the interval maximum. The 95th percentile still excludes rare intervals by design. At steady state, the decay gives the histogram an effective weight of

```text
1 / (1 - 0.983) = 58.82 intervals
```

One new tail has about 1.7% of that weight. Three consecutive tails have about 5.0%; tails farther apart have less combined weight. The decay half-life is about 20.2 seconds. The estimator commits a completed interval when a later arrival crosses the 500 ms boundary, so its reaction can lag by up to one interval.

The local pinned Chromium reference uses the same main parameters. `modules/audio_coding/neteq/delay_manager.h` sets a 0.95 quantile, a 0.983 forget factor, and a 500 ms resampling interval. `modules/audio_coding/neteq/underrun_optimizer.cc` records the interval maximum in 20 ms buckets. `modules/audio_coding/neteq/decision_logic.cc` uses a 2 second packet-arrival history. The local reference revision is `d9ec82c89d94c319e2a1f547c1bdd58591828455`. Matching these parameters does not provide the rest of NetEQ's controller, reorder handling, or packet-loss concealment.

## Measured result

One approximately 100 second 4K browser run used a 1000 ms audio reception horizon. The complete trace for decoded PCM seconds 5 through 99 showed no encoded packet loss before the decoder. Complete subscriber audio arrivals still had gaps of 165.18, 220.10, and 111.245 ms. The automatic target ranged from 43 to 120 ms and was 60 ms immediately before each gap.

For 20 ms PCM packets, an otherwise isolated arrival gap adds approximately `gap - 20 ms` of relative delay. The current bucket rule and its extra frame duration produce these instantaneous targets:

| Arrival gap | Approximate relative delay | Instantaneous target |
| ---: | ---: | ---: |
| 165.18 ms | 145.18 ms | 180 ms |
| 220.10 ms | 200.10 ms | 240 ms |
| 111.245 ms | 91.245 ms | 120 ms |

The three tail intervals account for about 1.5% of roughly 200 intervals. Their exclusion is therefore consistent with the 95th-percentile policy. The first tail was unforeseen. The 220 ms tail arrived about 2.9 seconds later, while the target remained 60 ms, so this run also shows that the estimator did not protect against the next rare tail.

The same measurement slice recorded 15,724 late and concealed output frames and 13,312 silent output frames. At 48 kHz, those counts are about 328 ms and 277 ms. The broader reception horizon retained the encoded audio in this slice, but it did not fix the audible interruption. A reception horizon controls which media remains eligible for delivery. It does not make a 95th-percentile playout target cover rarer delays.

These numbers describe one loaded browser run. They do not establish a general arrival distribution or a suitable replacement quantile. Events after the final measurement sample are excluded. The analysis uses the complete subscriber and decoder traces; absence from a bounded diagnostic ring is not evidence of missing media.

## Next measurement

The decoder probe records time before decoded PCM copying and before the application callback. `AudioBuffer.insert` records arrival after that work. Under load, those timestamps differ enough to change a histogram bucket. A follow-up run needs the source timestamp, arrival time, completed interval maximum, selected bucket, and target at the actual insertion boundary.

No quantile change follows from this run alone. If the product must protect against a repeated rare tail, test a temporary target increase after a completed large tail or an actual underrun. Let that temporary target decay to the existing 95th-percentile estimate. Compare its interruption count and added latency against the unchanged estimator.
