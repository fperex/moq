| metric | 500ms | auto |
|---|---|---|
| resolved jitter/delay/maxAge ms | 500/523/523 | 56.25/79.25/79.25 |
| ring target ms (last) | 523 | 79.3 |
| chunk ms | 20 | 20 |
| underrun episodes /min | 84.4 | 0 |
| underrun ms /min | 10732.1 | 0 |
| underrun episode ms p50/p90/max | 8/392/412 | null/null/null |
| skips /min | 0 | 0 |
| skipped ms /min | 0 | 0 |
| skip ms p50/p90/max | null/null/null | null/null/null |
| inserts into a dry ring % | 10.5 | 0 |
| buffered before insert ms p50/p90/min | 9.3/22.7/0 | 48.6/52.6/19.3 |
| media clock drift ms/s (insert / net) | 156.7 / 156.7 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 2611.3/4093.5/4309.2/4351.5 | 10.4/12.2/15.2/38.1 |
| net arrival lateness ms p50/p90/p99/max | 2611.3/4093.6/4309/4351.5 | 10.4/12/15/37.6 |
| net inter-arrival ms p50/p90/p99/max | 20.1/30.3/320.6/428.7 | 20.1/30.2/31.2/56 |
| decode latency ms p50/p90/max | null/null/null | null/null/null |
| pub->watch ms p50/p90/p99/max | 43.1/44/48.2/53.9 | 40.3/41.3/45.2/66.5 |
| audio groups / video groups / group skips / net stale / errs | 1560/19/0/0/0 | 2258/22/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) |
| audio late frames /min (max ms) | 2403.4 (6975.8) | 2999.4 (93.6) |
| sync reference changes | 6 | 0 |
| element audio buffered ms p10/p50/p90 (poll) | 0/58.7/73.3 | 60.6/79.3/88.6 |
| catalog changes seen | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 29.9 / 0 / 0 | 29.9 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 10/11, 3, 71.7 | 10/11, 3, 73 |
| worklet 100-quanta wall ms p50/max | 269.9/271.2 | 269.9/271.3 |
| window s | 38.4 | 45.2 |

publisher: {"audioChunks":4511,"driftMsPerS":94.7,"encodeInputs":4878,"encodeInputDriftMsPerS":0,"encodeInputLatenessMs":{"n":4878,"p50":10,"p90":10.3,"p99":10.6,"max":14.4,"min":0},"encodeQueue":{"n":4878,"p50":0,"p90":0,"p99":0,"max":0,"min":0},"encodeLatencyMs":{"n":4511,"p50":0.4,"p90":7340.3,"p99":7350.4,"max":7355.5,"min":0.2},"emitLatenessMs":{"n":4511,"p50":10.3,"p90":7350.2,"p99":7350.6,"max":7355.6,"min":0},"interEmitMs":{"n":4510,"p50":20,"p90":30,"p99":30.5,"max":429.8,"min":5.9}}