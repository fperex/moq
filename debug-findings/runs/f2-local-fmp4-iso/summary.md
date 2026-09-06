| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/126/126 | 250/253/253 | 500/503/503 | 20/46/46 |
| ring target ms (last) | 126 | 253 | 503 | 46 |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 0 | 0 |
| underrun ms /min | 0 | 0 | 0 | 0 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| skips /min | 0 | 2.2 | 0 | 7.7 |
| skipped ms /min | 0 | 0 | 0 | 197.6 |
| skip ms p50/p90/max | null/null/null | 72.1/72.1/72.1 | null/null/null | 23.7/31.9/31.9 |
| inserts into a dry ring % | 0 | 0 | 0 | 0.1 |
| buffered before insert ms p50/p90/min | 99.9/117.3/68 | 229.6/247/165.7 | 467.3/484.7/412.2 | 17.4/34.8/0 |
| media clock drift ms/s (insert / net) | 0 / 0 | -0.5 / 0 | 0 / 0 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 22.8/27.4/29.3/55.9 | 28.5/42.1/47.9/97.3 | 23.5/28/30.1/77.2 | 23.1/27.5/30.2/40.7 |
| net arrival lateness ms p50/p90/p99/max | 22.8/27.4/29.1/55.9 | 27.3/31.8/33.8/95.1 | 23.4/27.9/29.9/77 | 23.2/27.6/32.1/87 |
| net inter-arrival ms p50/p90/p99/max | 25.5/42.4/46.5/51.4 | 25.4/42.7/46.6/87.1 | 25.7/42.6/46.6/71.4 | 25.2/42.5/46.3/83.9 |
| decode latency ms p50/p90/max | 0.1/0.2/1.8 | 0.1/0.2/5.4 | 0.1/0.2/3.5 | 0.1/0.2/6.9 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 23/23/0/0/0 | 26/25/0/0/0 | 26/26/0/0/0 | 23/23/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 17.6 (51.8) |
| audio late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 61.8 (58.3) |
| sync reference changes | 3 | 4 | 1 | 0 |
| element audio buffered ms p10/p50/p90 (poll) | 111.5/131.8/160.8 | 241.2/276.2/287.6 | 493.4/516.6/525.4 | 14.5/40.6/52.2 |
| catalog changes seen | 0 | 1 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 23.9 / 0 / 0 | 23.9 / 0.5 / 0 | 23.9 / 0 / 0 | 23.9 / 0.5 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 45.3 | 6/255, 2, 45.2 | 6/11, 1, 45.3 | 6/11, 1, 45.4 |
| worklet 100-quanta wall ms p50/max | 288.1/299 | 288.1/752.9 | 288.1/298.8 | 288.1/298.8 |
| window s | 54.7 | 54.4 | 55.2 | 54.4 |