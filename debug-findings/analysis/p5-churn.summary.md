| metric | auto-2 | auto-3 | auto |
|---|---|---|---|
| resolved jitter/delay/maxAge ms | 20/43/43 | 20/43/43 | 20/43/43 |
| ring target ms (last) | 43 | 43 | 43 |
| chunk ms | 20 | 20 | 20 |
| underrun episodes /min | 0 | 3.4 | 0 |
| underrun ms /min | 0 | 254.4 | 0 |
| underrun episode ms p50/p90/max | null/null/null | 109/109/109 | null/null/null |
| skips /min | 0 | 5.1 | 0 |
| skipped ms /min | 0 | 49.5 | 0 |
| skip ms p50/p90/max | null/null/null | 9.3/11.7/11.7 | null/null/null |
| inserts into a dry ring % | 0 | 0.3 | 0 |
| buffered before insert ms p50/p90/min | 15/23/3 | 13.7/23/0 | 15/23/3 |
| media clock drift ms/s (insert / net) | 0 / 0 | 0.7 / 0.7 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 11.3/12.6/15.2/26.2 | 19.8/30.8/130.7/171.4 | 11.2/12.4/13.6/27.2 |
| net arrival lateness ms p50/p90/p99/max | 11.2/12.5/14.9/26.1 | 19.8/30.8/130.7/168.6 | 11.3/12.4/13.8/27.2 |
| net inter-arrival ms p50/p90/p99/max | 20/30.4/31.9/42.9 | 19.9/30.4/31.8/139 | 20/30.3/31.6/39.9 |
| decode latency ms p50/p90/max | null/null/null | null/null/null | null/null/null |
| pub->watch ms p50/p90/p99/max | 2.8/3.7/6/17 | 3.2/4.2/6.4/25.9 | 2.2/3.3/4.8/18.1 |
| audio groups / video groups / group skips / net stale / errs | 1755/17/0/0/0 | 1752/17/0/0/0 | 1758/17/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) |
| audio late frames /min (max ms) | 2256.1 (18.3) | 2271.2 (162.3) | 2254.4 (19.7) |
| sync reference changes | 3 | 0 | 0 |
| element audio buffered ms p10/p50/p90 (poll) | 35/52.3/56.3 | 0/51/61.7 | 35/56.3/75 |
| catalog changes seen | 0 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 29.9 / 0 / 0 | 29.9 / 0 / 0 | 29.9 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 10/11, 3, 72.3 | 11/11, 3, 71 | 10/11, 3, 72.8 |
| worklet 100-quanta wall ms p50/max | 270/270.4 | 269.9/270.4 | 269.9/270.5 |
| window s | 35.1 | 35.1 | 35.2 |

publisher: {"audioChunks":6547,"driftMsPerS":0.2,"writeFrameMs":{"n":6547,"p50":0.1,"p90":0.2,"p99":0.8,"max":4.4,"min":0},"outputLagPer10s":"0s:8 10s:8 20s:8 30s:8 40s:8 50s:8 60s:8 70s:8 80s:8 90s:8 100s:8 110s:8 120s:48 130s:148","encodeInputs":6554,"encodeInputDriftMsPerS":0,"encodeInputLatenessMs":{"n":6554,"p50":10.3,"p90":10.6,"p99":11,"max":28.6,"min":0},"encodeQueue":{"n":6554,"p50":0,"p90":0,"p99":0,"max":0,"min":0},"encodeLatencyMs":{"n":6547,"p50":0.3,"p90":0.6,"p99":140.3,"max":151.1,"min":0.2},"emitLatenessMs":{"n":6547,"p50":10.4,"p90":10.9,"p99":150.5,"max":154.9,"min":0},"interEmitMs":{"n":6546,"p50":20,"p90":30.1,"p99":30.6,"max":139.8,"min":2.2}}