| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/127/127 | 250/277/277 | 500/527/527 | 47.5/74.5/74.5 |
| ring target ms (last) |  |  |  |  |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 0 | 0 |
| underrun ms /min | 0 | 0 | 0 | 0 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| skips /min | 0 | 0 | 0 | 0 |
| skipped ms /min | 12760.2 | 0 | 0 | 28531.3 |
| skip ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| inserts into a dry ring % | 0 | 0 | 0 | 0 |
| buffered before insert ms p50/p90/min | null/null/null | null/null/null | null/null/null | null/null/null |
| media clock drift ms/s (insert / net) | 0.2 / 0.1 | 0.1 / 0.1 | 0.1 / 0.1 | 1.2 / 0.1 |
| insert arrival lateness ms p50/p90/p99/max | 106.6/174.5/205.4/228.1 | 111.7/179/211.1/253.4 | 110.7/179.2/220.4/425 | 163.7/247.4/308.1/358.7 |
| net arrival lateness ms p50/p90/p99/max | 106.4/170.4/201/221.4 | 111.1/175.4/206.9/252.7 | 110.5/175.4/220.2/425.4 | 113.2/173.9/203.3/256.1 |
| net inter-arrival ms p50/p90/p99/max | 0.2/135.6/198.5/226.1 | 0.1/139.5/200.3/242.8 | 0.1/137.9/199.2/411.7 | 0.8/135.4/194.9/261.2 |
| decode latency ms p50/p90/max | 1/6.8/15.7 | 3594.5/3687.1/3808 | 3543.6/3617.8/3954.6 | 5.2/164.2/242.9 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 2379/6/73/0/0 | 2380/26/0/0/0 | 2373/27/0/0/0 | 2375/27/566/6/0 |
| video late frames /min (max ms) | 58.7 (2145.8) | 0 (null) | 0 (null) | 202.1 (134.1) |
| audio late frames /min (max ms) | 955.6 (97.9) | 0 (null) | 0 (null) | 1439 (163.3) |
| sync reference changes | 10 | 2 | 0 | 292 |
| element audio buffered ms p10/p50/p90 (poll) | 0/51.5/115.4 | 53.5/163.8/230.6 | 187.4/410.9/469 | 0/7.8/68.7 |
| catalog changes seen | 0 | 0 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 6 / 23.5 / 0.5 | 23.9 / 0 / 0 | 23.8 / 0 / 0 | 23.8 / 53.6 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 43.8 | 6/11, 1, 44.3 | 6/11, 1, 44.8 | 6/11, 1, 44.4 |
| worklet 100-quanta wall ms p50/max | 288.1/304.3 | 288.1/298.8 | 288.1/299.2 | 288.1/305.3 |
| window s | 55.2 | 55.2 | 55.1 | 55.2 |