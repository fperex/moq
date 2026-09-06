| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/126/126 | 250/253/253 | 500/503/503 | 20/46/46 |
| ring target ms (last) |  |  |  |  |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 0 | 0 |
| underrun ms /min | 0 | 0 | 0 | 0 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| skips /min | 0 | 0 | 0 | 0 |
| skipped ms /min | 0 | 28.8 | 0 | 135.1 |
| skip ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| inserts into a dry ring % | 0 | 0 | 0 | 0 |
| buffered before insert ms p50/p90/min | null/null/null | null/null/null | null/null/null | null/null/null |
| media clock drift ms/s (insert / net) | 0 / 0 | -0.4 / 0 | 0 / 0 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 22.3/27.7/29.3/54.4 | 35.9/49.7/55.3/88.7 | 21.5/26.7/29.2/78.4 | 21.5/26.3/28.8/76.2 |
| net arrival lateness ms p50/p90/p99/max | 22.4/27.7/29.4/54.5 | 27.6/32.8/34.8/80.3 | 21.6/26.7/29/78.4 | 21.6/26.4/28.8/76.2 |
| net inter-arrival ms p50/p90/p99/max | 25.7/41.9/45/49.3 | 26/41.8/45.1/77.2 | 25.7/42/45.4/75.9 | 26/42/45/74.7 |
| decode latency ms p50/p90/max | 0.1/0.2/1.1 | 0.1/0.2/2.4 | 0.1/0.2/2.5 | 0.1/0.2/1.3 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 23/23/0/0/0 | 26/25/0/0/0 | 26/26/0/0/0 | 23/23/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 13.1 (41.4) |
| audio late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 40.4 (48) |
| sync reference changes | 0 | 2 | 1 | 4 |
| element audio buffered ms p10/p50/p90 (poll) | 73.8/97/123.1 | 209.5/249.9/264.4 | 459.5/485.6/497.2 | 5.8/31.9/43.5 |
| catalog changes seen | 0 | 1 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 23.9 / 0 / 0 | 23.9 / 0.9 / 0 | 23.8 / 0 / 0 | 23.9 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 45.2 | 6/252, 2, 45.5 | 6/11, 1, 44.9 | 6/11, 1, 45.2 |
| worklet 100-quanta wall ms p50/max | 288.1/298.9 | 288.1/1007.6 | 288.1/298.9 | 288.1/298.8 |
| window s | 54.7 | 54.4 | 55.2 | 54.9 |