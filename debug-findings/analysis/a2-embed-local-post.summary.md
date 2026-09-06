| metric | 100ms | 500ms | auto |
|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/126/126 | 500/503/503 | 20/46/46 |
| ring target ms (last) |  |  |  |
| chunk ms | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 308.4 |
| underrun ms /min | 0 | 0 | 674.2 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | 0.4/3.3/55.1 |
| skips /min | 0 | 0 | 0 |
| skipped ms /min | 12.7 | -188.3 | 689.6 |
| skip ms p50/p90/max | null/null/null | null/null/null | null/null/null |
| inserts into a dry ring % | 0 | 0 | 0 |
| buffered before insert ms p50/p90/min | null/null/null | null/null/null | null/null/null |
| media clock drift ms/s (insert / net) | -0.1 / -0.1 | 0.3 / 3.4 | -0.3 / -0.3 |
| insert arrival lateness ms p50/p90/p99/max | 22.9/27.9/30.7/54.4 | 27.4/38.1/179.7/244.9 | 31.3/40.9/45/95.6 |
| net arrival lateness ms p50/p90/p99/max | 22.7/27.7/30.2/54.4 | 117.7/194/2000.1/2555.4 | 31.1/40.8/44.7/95.5 |
| net inter-arrival ms p50/p90/p99/max | 25.7/41.7/46/52.1 | 24.6/42/47/242.3 | 26.2/41.8/46.2/81.2 |
| decode latency ms p50/p90/max | 0.1/0.2/2.9 | 0.1/0.2/3.4 | 0.1/0.2/2.8 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 23/0/0/0/0 | 25/3/0/14/0 | 23/8/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 6.6 (53.6) |
| audio late frames /min (max ms) | 0 (null) | 87.1 (2032.8) | 184.8 (59.6) |
| sync reference changes | 0 | 1 | 3 |
| element audio buffered ms p10/p50/p90 (poll) | 62.2/108.6/120.2 | 302.7/508.6/520.2 | 0/20.3/34.8 |
| catalog changes seen | 0 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 0 / 0 / 0 | 3.2 / 0 / 0 | 8.4 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 44.9 | 6/41, 3, 45.1 | 6/11, 1, 45.3 |
| worklet 100-quanta wall ms p50/max | 288.1/299 | 288.1/563.1 | 288.1/298.7 |
| window s | 54.7 | 54.4 | 54.9 |