| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/126/126 | 250/277/277 | 500/527/527 | 20/46/46 |
| ring target ms (last) |  |  |  |  |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 0 | 0 |
| underrun ms /min | 0 | 0 | 0 | 0 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| skips /min | 0 | 0 | 0 | 0 |
| skipped ms /min | 0 | 27.7 | 0 | 412.2 |
| skip ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| inserts into a dry ring % | 0 | 0 | 0 | 0 |
| buffered before insert ms p50/p90/min | null/null/null | null/null/null | null/null/null | null/null/null |
| media clock drift ms/s (insert / net) | 0 / 0 | -0.4 / 0 | 0 / 0 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 22.4/27.6/29.5/63.3 | 35.1/49.2/54.6/81.1 | 22.2/27/29.1/77.9 | 22.9/27.5/32/84.9 |
| net arrival lateness ms p50/p90/p99/max | 22.3/27.4/29.4/63.2 | 27.2/32/34.3/74.4 | 22.1/26.9/28.8/77.7 | 22.9/27.4/31.8/84.9 |
| net inter-arrival ms p50/p90/p99/max | 26.3/41.5/45.3/74.7 | 25.3/41.6/45.4/68.3 | 25.6/41.8/45.5/73.5 | 25.9/41.8/46/78.8 |
| decode latency ms p50/p90/max | 0.1/0.2/1.6 | 0.1/0.2/6.4 | 0.1/0.2/2.7 | 0.1/0.2/3.2 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 23/21/0/0/0 | 25/24/0/0/0 | 26/26/0/0/0 | 23/23/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 13.1 (54.5) |
| audio late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 43.7 (54.7) |
| sync reference changes | 1 | 1 | 5 | 5 |
| element audio buffered ms p10/p50/p90 (poll) | 91.2/108.6/120.2 | 23.2/255.7/272.8 | 493.4/513.7/522.5 | 8.7/34.8/46.4 |
| catalog changes seen | 0 | 1 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 21.6 / 0 / 0 | 23.9 / 0.5 / 0 | 23.8 / 0 / 0 | 23.9 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 3, 45 | 6/11, 1, 44.9 | 6/11, 1, 44.9 | 6/11, 1, 45.3 |
| worklet 100-quanta wall ms p50/max | 288.1/298.8 | 288.1/298.9 | 288.1/299.3 | 288.1/299.1 |
| window s | 54.6 | 54.4 | 55.1 | 54.9 |