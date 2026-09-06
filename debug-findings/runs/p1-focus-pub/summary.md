| metric | auto |
|---|---|
| resolved jitter/delay/maxAge ms | 20/43/43 |
| ring target ms (last) | 43 |
| chunk ms | 20 |
| underrun episodes /min | 280.6 |
| underrun ms /min | 23950.4 |
| underrun episode ms p50/p90/max | 1.3/240/400 |
| skips /min | 0 |
| skipped ms /min | 0 |
| skip ms p50/p90/max | null/null/null |
| inserts into a dry ring % | 35.1 |
| buffered before insert ms p50/p90/min | 1.3/4/0 |
| media clock drift ms/s (insert / net) | 453.6 / 453.6 |
| insert arrival lateness ms p50/p90/p99/max | 444.4/771.1/906/943 |
| net arrival lateness ms p50/p90/p99/max | 444.4/771.1/906/942.6 |
| net inter-arrival ms p50/p90/p99/max | 20.1/21.5/338.4/421.4 |
| decode latency ms p50/p90/max | null/null/null |
| pub->watch ms p50/p90/p99/max | 1.9/2.7/4.7/5.7 |
| audio groups / group skips / net stale / errs | 442/3/0/0 |
| video late frames /min (max ms) | 0 (null) |
| audio late frames /min (max ms) | 1746.9 (7117.5) |
| sync reference changes | 0 |
| rendered fps / audio stalled % / video stalled % | 19.8 / 0 / 0 |
| worklet 100-quanta wall ms p50/max | 269.9/270.3 |
| window s | 15.2 |

publisher: {"audioChunks":804,"driftMsPerS":379.9,"encodeInputs":1170,"encodeInputDriftMsPerS":0,"encodeInputLatenessMs":{"n":1170,"p50":0.2,"p90":0.4,"p99":0.8,"max":6.1,"min":0},"encodeQueue":{"n":1170,"p50":0,"p90":0,"p99":0,"max":0,"min":0},"encodeLatencyMs":{"n":804,"p50":3320.3,"p90":7180.7,"p99":7320.1,"max":7320.5,"min":0.2},"emitLatenessMs":{"n":804,"p50":3320.2,"p90":7180.6,"p99":7320.2,"max":7320.5,"min":0},"interEmitMs":{"n":803,"p50":20,"p90":20.3,"p99":260.1,"max":420.3,"min":14.2}}