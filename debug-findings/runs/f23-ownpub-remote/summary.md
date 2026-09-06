| metric | 500ms | auto |
|---|---|---|
| resolved jitter/delay/maxAge ms | 500/523/523 | 55/78/78 |
| ring target ms (last) | 523 | 78 |
| chunk ms | 20 | 20 |
| underrun episodes /min | 0 | 0 |
| underrun ms /min | 0 | 0 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null |
| skips /min | 4 | 0 |
| skipped ms /min | 110.3 | 0 |
| skip ms p50/p90/max | 27.7/29/29 | null/null/null |
| inserts into a dry ring % | 0 | 0 |
| buffered before insert ms p50/p90/min | 401.7/501.7/1.7 | 60/62.7/5.3 |
| media clock drift ms/s (insert / net) | 69.5 / 69.9 | 25.3 / 25.3 |
| insert arrival lateness ms p50/p90/p99/max | 504.1/683.5/767/789.8 | 271.4/457.9/856.7/874.4 |
| net arrival lateness ms p50/p90/p99/max | 513.5/689.5/780.8/803.8 | 273.2/461.4/857.8/874.2 |
| net inter-arrival ms p50/p90/p99/max | 20/30.2/33.8/420.2 | 20/30.2/33.2/422.8 |
| decode latency ms p50/p90/max | null/null/null | null/null/null |
| pub->watch ms p50/p90/p99/max | 43.2/44.8/47.5/61.2 | 41.5/43.2/47/60.7 |
| audio groups / video groups / group skips / net stale / errs | 2105/22/0/0/0 | 2186/22/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) |
| audio late frames /min (max ms) | 2796.9 (4439.8) | 2903.4 (1488.3) |
| sync reference changes | 4 | 3 |
| element audio buffered ms p10/p50/p90 (poll) | 0/440.3/552.3 | 0/81.3/90.7 |
| catalog changes seen | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 29.7 / 7.8 / 0 | 29.9 / 3.3 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 10/11, 3, 73.3 | 10/11, 3, 71.2 |
| worklet 100-quanta wall ms p50/max | 269.9/270.6 | 269.9/270.5 |
| window s | 45.2 | 45.2 |

publisher: {"audioChunks":5097,"driftMsPerS":49.7,"writeFrameMs":{"n":5097,"p50":0.2,"p90":0.4,"p99":0.8,"max":1.8,"min":0},"outputLagPer10s":"0s:51 10s:127 20s:414 30s:523 40s:970 50s:1738 60s:2204 70s:2661 80s:3598 90s:4163 100s:4873","encodeInputs":5363,"encodeInputDriftMsPerS":0,"encodeInputLatenessMs":{"n":5363,"p50":0.4,"p90":10.3,"p99":10.6,"max":15.9,"min":0},"encodeQueue":{"n":5363,"p50":0,"p90":0,"p99":0,"max":0,"min":0},"encodeLatencyMs":{"n":5097,"p50":1521.1,"p90":4219.7,"p99":4921.4,"max":5331,"min":0.2},"emitLatenessMs":{"n":5097,"p50":1530.4,"p90":4220.4,"p99":4921.6,"max":5331.1,"min":0},"interEmitMs":{"n":5096,"p50":20,"p90":30,"p99":30.6,"max":420.2,"min":2.9}}