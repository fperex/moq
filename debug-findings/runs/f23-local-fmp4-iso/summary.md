| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/126/126 | 250/277/277 | 500/527/527 | 20/46/46 |
| ring target ms (last) | 126 | 277 | 527 | 46 |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 0 | 0 |
| underrun ms /min | 0 | 0 | 0 | 0 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| skips /min | 0 | 1.1 | 0 | 7.7 |
| skipped ms /min | 0 | 27.7 | 0 | 205.4 |
| skip ms p50/p90/max | null/null/null | 25.1/25.1/25.1 | null/null/null | 23.7/41.1/41.1 |
| inserts into a dry ring % | 0 | 0 | 0 | 0.2 |
| buffered before insert ms p50/p90/min | 85.4/99.9/38.9 | 238.3/252.8/177.3 | 489.3/506.7/434.1 | 19.9/37.3/0 |
| media clock drift ms/s (insert / net) | 0 / 0 | -0.4 / 0 | 0 / 0 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 21.7/26.5/28.5/67.1 | 35.1/49.2/54.4/90.6 | 22.6/27.2/29.1/74.1 | 22.4/26.9/28.7/46.4 |
| net arrival lateness ms p50/p90/p99/max | 21.7/26.4/28.4/66.9 | 27.2/31.8/33.4/81.9 | 22.5/27/29/74 | 22.6/27/29.2/87.3 |
| net inter-arrival ms p50/p90/p99/max | 26.2/42.2/46.1/66.2 | 25.9/42.1/46.1/74.5 | 26.1/42.2/46.2/70.1 | 25.4/42.6/46.6/89 |
| decode latency ms p50/p90/max | 0.1/0.2/1.7 | 0.1/0.2/2.1 | 0.1/0.2/2.8 | 0.1/0.2/2.5 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 23/23/0/0/0 | 25/24/0/0/0 | 26/26/0/0/0 | 23/23/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 15.3 (51) |
| audio late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 72.2 (59.5) |
| sync reference changes | 3 | 1 | 1 | 1 |
| element audio buffered ms p10/p50/p90 (poll) | 88.3/114.4/123.1 | 23.2/278.9/293.2 | 498/518.3/527 | 17.4/43.1/52.2 |
| catalog changes seen | 0 | 1 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 23.8 / 0 / 0 | 23.8 / 0.9 / 0 | 23.9 / 0 / 0 | 23.8 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 45.3 | 6/11, 1, 45.3 | 6/11, 1, 45.3 | 6/11, 1, 45.3 |
| worklet 100-quanta wall ms p50/max | 288.1/298.8 | 288.1/298.9 | 288.1/298.9 | 288.1/298.9 |
| window s | 54.4 | 54.4 | 55.2 | 54.9 |