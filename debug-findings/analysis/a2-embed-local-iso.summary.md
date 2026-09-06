| metric | 100ms | 500ms | auto |
|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/126/126 | 500/503/503 | 20/46/46 |
| ring target ms (last) | 126 | 503 | 46 |
| chunk ms | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 296.2 |
| underrun ms /min | 0 | 0 | 2771 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | 2.9/20.3/650.2 |
| skips /min | 1.1 | 5.5 | 433.4 |
| skipped ms /min | 3.2 | -1113.7 | 2767.4 |
| skip ms p50/p90/max | 2.9/2.9/2.9 | 2.9/17.4/17.4 | 2.9/17.4/87.1 |
| inserts into a dry ring % | 0 | 0 | 17.2 |
| buffered before insert ms p50/p90/min | 76.7/94.1/41.8 | 476.7/494.1/308.5 | 8.3/25.7/0 |
| media clock drift ms/s (insert / net) | 0 / 0 | 44.4 / 0.1 | 1.8 / 1.8 |
| insert arrival lateness ms p50/p90/p99/max | 22.2/27.1/29.6/55.6 | 1210.6/2216.4/2424/2455.7 | 76.8/134.4/379.1/769.3 |
| net arrival lateness ms p50/p90/p99/max | 22.2/26.9/29.3/55.6 | 28.9/35/37.8/2519.4 | 76.7/134.3/379/769.3 |
| net inter-arrival ms p50/p90/p99/max | 25.8/42/45.4/47.4 | 26.3/42.1/45.7/141.2 | 23.8/41.7/54/677.3 |
| decode latency ms p50/p90/max | 0.1/0.2/4.5 | 0.1/2459.9/2608.7 | 0.1/0.2/4.1 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 23/0/0/0/0 | 26/15/1/14/0 | 23/2/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 19.7 (726.2) |
| audio late frames /min (max ms) | 0 (null) | 1.1 (2028.2) | 527.7 (725.8) |
| sync reference changes | 0 | 4 | 0 |
| element audio buffered ms p10/p50/p90 (poll) | 53.5/99.9/126 | 46.4/502.8/514.4 | 0/31.5/43.1 |
| catalog changes seen | 0 | 1 | 0 |
| rendered fps / audio stalled % / video stalled % | 0 / 0 / 0 | 14.6 / 0.9 / 0 | 1.8 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 45.4 | 6/41, 3, 45.7 | 6/11, 1, 44.4 |
| worklet 100-quanta wall ms p50/max | 288.1/299 | 288.1/448.1 | 288.1/298.9 |
| window s | 54.4 | 54.4 | 54.7 |