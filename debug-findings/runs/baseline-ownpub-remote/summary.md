| metric | 500ms | auto |
|---|---|---|
| resolved jitter/delay/maxAge ms | 500/523/523 | 47.5/70.5/70.5 |
| ring target ms (last) | 523 | 70.5 |
| chunk ms | 20 | 20 |
| underrun episodes /min | 271 | 86.3 |
| underrun ms /min | 31504.1 | 2575.6 |
| underrun episode ms p50/p90/max | 9.3/396/406.7 | 1.3/80/280 |
| skips /min | 0 | 0 |
| skipped ms /min | 0 | 0 |
| skip ms p50/p90/max | null/null/null | null/null/null |
| inserts into a dry ring % | 25.2 | 14.3 |
| buffered before insert ms p50/p90/min | 8/13.3/0 | 4/29.3/0 |
| media clock drift ms/s (insert / net) | 526.9 / 526.9 | 55.2 / 55.2 |
| insert arrival lateness ms p50/p90/p99/max | 1788.3/2460/2908.4/2982.4 | 446/962.7/1098.6/1114.8 |
| net arrival lateness ms p50/p90/p99/max | 1788.4/2460.1/2908.4/2982.4 | 446.4/963/1099/1115 |
| net inter-arrival ms p50/p90/p99/max | 20/22.4/420.8/421.9 | 20/21/40.6/300.2 |
| decode latency ms p50/p90/max | null/null/null | null/null/null |
| pub->watch ms p50/p90/p99/max | 48.8/49.9/51.8/59 | 49.5/50.4/53.1/56.9 |
| audio groups / video groups / group skips / net stale / errs | 1049/23/0/0/0 | 2162/19/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 19.9 (479.8) |
| audio late frames /min (max ms) | 1393.7 (27578.3) | 2870.3 (2091.8) |
| sync reference changes | 2 | 1 |
| element audio buffered ms p10/p50/p90 (poll) | 0/20/54.7 | 0/60/72 |
| catalog changes seen | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 29.9 / 0 / 0 | 24.8 / 0 / 0.6 |
| worklet read gap ms p50/max, burst quanta max, burst % | 10/11, 3, 72.9 | 10/11, 3, 72.1 |
| worklet 100-quanta wall ms p50/max | 269.9/270.8 | 269.8/271.1 |
| window s | 45.2 | 45.2 |

publisher: {"audioChunks":3879,"driftMsPerS":274.5,"writeFrameMs":{"n":3879,"p50":0.1,"p90":0.3,"p99":0.6,"max":1.1,"min":0},"outputLagPer10s":"0s:68 10s:333 20s:1501 30s:1831 40s:2038 50s:2336 60s:8092 70s:14452 80s:20256 90s:24618 100s:28009","encodeInputs":5366,"encodeInputDriftMsPerS":0,"encodeInputLatenessMs":{"n":5366,"p50":0.4,"p90":0.7,"p99":1.3,"max":13.8,"min":0},"encodeQueue":{"n":5366,"p50":0,"p90":0,"p99":0,"max":0,"min":0},"encodeLatencyMs":{"n":3879,"p50":2020.4,"p90":24220.2,"p99":29621,"max":29742.6,"min":0.2},"emitLatenessMs":{"n":3879,"p50":2020.5,"p90":24220.6,"p99":29621.3,"max":29742.7,"min":0},"interEmitMs":{"n":3878,"p50":20,"p90":20.3,"p99":419.5,"max":421.4,"min":6.3}}