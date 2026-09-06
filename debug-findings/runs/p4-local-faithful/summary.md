| metric | 100ms | 500ms | auto |
|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/123/123 | 500/523/523 | 20/43/43 |
| ring target ms (last) | 123 | 523 | 43 |
| chunk ms | 20 | 20 | 20 |
| underrun episodes /min | 0 | 0 | 4 |
| underrun ms /min | 0 | 0 | 46.5 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | 7.7/19.7/19.7 |
| skips /min | 0 | 0 | 9.3 |
| skipped ms /min | 0 | 0 | 46.5 |
| skip ms p50/p90/max | null/null/null | null/null/null | 6.3/9.3/9.3 |
| inserts into a dry ring % | 0 | 0 | 0.1 |
| buffered before insert ms p50/p90/min | 100.3/103/81.7 | 440.3/500.3/269.7 | 21.7/23/0 |
| media clock drift ms/s (insert / net) | 0 / 0 | 5.4 / 5.4 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 1.2/2.4/7.4/21.2 | 83.3/139.4/157.4/159.3 | 1.3/2.3/4.9/47.2 |
| net arrival lateness ms p50/p90/p99/max | 1.1/2.2/6.8/20.9 | 83.3/139.5/157.4/159.3 | 1.2/2.1/4.8/47 |
| net inter-arrival ms p50/p90/p99/max | 20/21/24.2/39.7 | 20/21/26.1/178.9 | 20/20.9/22.4/65.4 |
| decode latency ms p50/p90/max | null/null/null | null/null/null | null/null/null |
| pub->watch ms p50/p90/p99/max | 2.9/4.1/7.9/22.6 | 3.6/4.6/9.5/37 | 2.1/2.9/5.4/47.8 |
| audio groups / video groups / group skips / net stale / errs | 2255/22/0/0/0 | 1873/19/0/0/0 | 2258/23/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) |
| audio late frames /min (max ms) | 0 (null) | 0 (null) | 8 (36.3) |
| sync reference changes | 3 | 3 | 2 |
| element audio buffered ms p10/p50/p90 (poll) | 103/123/132.3 | 299/473.7/533.7 | 59/69.7/81.7 |
| catalog changes seen | 0 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 29.8 / 0 / 0 | 29.9 / 0 / 0 | 29.7 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 10/11, 3, 71 | 10/11, 3, 73.1 | 10/11, 3, 71 |
| worklet 100-quanta wall ms p50/max | 269.9/270.4 | 269.8/270.4 | 269.9/271.6 |
| window s | 45.1 | 37.7 | 45.1 |

publisher: {"audioChunks":7474,"driftMsPerS":0.7,"encodeInputs":7485,"encodeInputDriftMsPerS":0,"encodeInputLatenessMs":{"n":7485,"p50":0.4,"p90":0.6,"p99":1,"max":23.4,"min":0},"encodeQueue":{"n":7485,"p50":0,"p90":0,"p99":0,"max":0,"min":0},"encodeLatencyMs":{"n":7474,"p50":0.3,"p90":60.3,"p99":220.3,"max":221.2,"min":0.2},"emitLatenessMs":{"n":7474,"p50":0.5,"p90":60.6,"p99":220.6,"max":221.5,"min":0},"interEmitMs":{"n":7473,"p50":20,"p90":20.3,"p99":20.8,"max":179.9,"min":1.1}}