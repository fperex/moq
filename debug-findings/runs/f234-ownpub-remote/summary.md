| metric | 500ms | auto |
|---|---|---|
| resolved jitter/delay/maxAge ms | 500/523/523 | 1000/1023/1023 |
| ring target ms (last) | 523 | 1023 |
| chunk ms | 20 | 20 |
| underrun episodes /min | 0 | 0 |
| underrun ms /min | 0 | 0 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null |
| skips /min | 5.3 | 2.7 |
| skipped ms /min | 129.4 | 35.7 |
| skip ms p50/p90/max | 25/26.3/26.3 | null/null/null |
| inserts into a dry ring % | 0 | 0 |
| buffered before insert ms p50/p90/min | 203/495/3 | 266.7/586.7/1.3 |
| media clock drift ms/s (insert / net) | 68.8 / 69 | 116.2 / 116.8 |
| insert arrival lateness ms p50/p90/p99/max | 469.8/690.9/815.6/846.7 | 859.4/1379.3/1701.9/1748.4 |
| net arrival lateness ms p50/p90/p99/max | 477.4/693.8/817.7/851.2 | 844/1362.3/1712.4/1764.1 |
| net inter-arrival ms p50/p90/p99/max | 20.2/30.4/34/430.3 | 20/30.5/38.1/430.1 |
| decode latency ms p50/p90/max | null/null/null | null/null/null |
| pub->watch ms p50/p90/p99/max | 47.5/49.2/51.6/62.6 | 46.8/48.4/51.1/60.9 |
| audio groups / video groups / group skips / net stale / errs | 2115/22/0/0/0 | 2035/22/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) |
| audio late frames /min (max ms) | 2811.1 (7653.8) | 1616.5 (3495.3) |
| sync reference changes | 2 | 2 |
| element audio buffered ms p10/p50/p90 (poll) | 0/253.7/543 | 0/309.3/646.7 |
| catalog changes seen | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 29.8 / 6.7 / 0 | 29.9 / 11 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 10/11, 3, 72.7 | 10/11, 3, 73.3 |
| worklet 100-quanta wall ms p50/max | 269.9/270.6 | 269.9/270.5 |
| window s | 45.1 | 45.2 |

publisher: {"audioChunks":4957,"driftMsPerS":88,"writeFrameMs":{"n":4957,"p50":0.2,"p90":0.3,"p99":0.7,"max":2.2,"min":0},"outputLagPer10s":"0s:6 10s:118 20s:1052 30s:2424 40s:4128 50s:4863 60s:5550 70s:5973 80s:6480 90s:7702 100s:8105","encodeInputs":5364,"encodeInputDriftMsPerS":0,"encodeInputLatenessMs":{"n":5364,"p50":10,"p90":10.3,"p99":10.8,"max":27.6,"min":0},"encodeQueue":{"n":5364,"p50":0,"p90":0,"p99":0,"max":0,"min":0},"encodeLatencyMs":{"n":4957,"p50":4481.4,"p90":7760.8,"p99":8150.2,"max":8152.9,"min":0.2},"emitLatenessMs":{"n":4957,"p50":4491,"p90":7770.7,"p99":8150.7,"max":8153,"min":0},"interEmitMs":{"n":4956,"p50":20,"p90":30,"p99":31,"max":430.2,"min":0.5}}