| metric | 500ms | auto |
|---|---|---|
| resolved jitter/delay/maxAge ms | 500/523/523 | 47.5/70.5/70.5 |
| ring target ms (last) | 523 | 70.5 |
| chunk ms | 20 | 20 |
| underrun episodes /min | 0 | 0 |
| underrun ms /min | 0 | 0 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null |
| skips /min | 4 | 12 |
| skipped ms /min | 97.8 | 272.9 |
| skip ms p50/p90/max | 26.3/26.3/26.3 | 22.8/22.8/22.8 |
| inserts into a dry ring % | 0 | 0 |
| buffered before insert ms p50/p90/min | 361.7/505.7/71 | 49.2/61.3/35.8 |
| media clock drift ms/s (insert / net) | 154.2 / 155 | 455.2 / 456.9 |
| insert arrival lateness ms p50/p90/p99/max | 1383.7/3178.8/3707.1/3760.1 | 1999.7/2987.3/3995.9/4104.5 |
| net arrival lateness ms p50/p90/p99/max | 1396.3/3241/3749.5/3805.3 | 1968/2929.1/3997.5/4121.9 |
| net inter-arrival ms p50/p90/p99/max | 20.2/30.1/81.2/438.5 | 20.2/30.6/421.5/432.2 |
| decode latency ms p50/p90/max | null/null/null | null/null/null |
| pub->watch ms p50/p90/p99/max | 41.1/41.8/44/48.6 | 41.2/42.4/45/58.3 |
| audio groups / video groups / group skips / net stale / errs | 1973/22/0/0/0 | 1361/23/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) |
| audio late frames /min (max ms) | 2619.7 (25277.4) | 1807.7 (18023.2) |
| sync reference changes | 2 | 5 |
| element audio buffered ms p10/p50/p90 (poll) | 0/401.7/563 | 0/66.5/86.7 |
| catalog changes seen | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 29.7 / 13.3 / 0 | 29.7 / 41.7 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 11/11, 3, 69.6 | 11/11, 3, 69.2 |
| worklet 100-quanta wall ms p50/max | 269.9/270.4 | 269.9/270.6 |
| window s | 45.2 | 45.2 |

publisher: {"audioChunks":4078,"driftMsPerS":284.1,"writeFrameMs":{"n":4078,"p50":0.1,"p90":0.3,"p99":0.6,"max":1.5,"min":0},"outputLagPer10s":"0s:75 10s:572 20s:6972 30s:12274 40s:16377 50s:19625 60s:20371 70s:23501 80s:25503 90s:25671 100s:25743","encodeInputs":5365,"encodeInputDriftMsPerS":0,"encodeInputLatenessMs":{"n":5365,"p50":0.5,"p90":10.4,"p99":10.8,"max":14.8,"min":0},"encodeQueue":{"n":5365,"p50":0,"p90":0,"p99":0,"max":0,"min":0},"encodeLatencyMs":{"n":4078,"p50":20000.6,"p90":25740.4,"p99":25750.7,"max":25755.1,"min":0.2},"emitLatenessMs":{"n":4078,"p50":20001,"p90":25740.8,"p99":25750.9,"max":25755.2,"min":0},"interEmitMs":{"n":4077,"p50":20,"p90":30,"p99":410.5,"max":430.9,"min":5.5}}