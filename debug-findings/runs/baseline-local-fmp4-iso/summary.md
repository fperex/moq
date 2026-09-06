| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/126/126 | 250/253/253 | 500/503/503 | 20/46/46 |
| ring target ms (last) | 126 | 253 | 503 | 46 |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 0 | 366.5 |
| underrun ms /min | 0 | 0 | 0 | 812.3 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | null/null/null | 0.4/3.3/58 |
| skips /min | 1.1 | 2.2 | 1.1 | 362.1 |
| skipped ms /min | 3.2 | 3.2 | 3.2 | 801.8 |
| skip ms p50/p90/max | 2.9/2.9/2.9 | 118.5/118.5/118.5 | 2.9/2.9/2.9 | 0.4/3.3/37.7 |
| inserts into a dry ring % | 0 | 0 | 0 | 21.4 |
| buffered before insert ms p50/p90/min | 79.6/97/27.3 | 226.7/244.1/186.3 | 453.7/471.1/392.7 | 5.8/23.2/0 |
| media clock drift ms/s (insert / net) | 0 / 0 | -0.4 / 0 | 0 / 0 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 22/26.5/28.3/71.4 | 29.6/43.1/48.6/70.9 | 22/26.8/28.5/83.4 | 22.6/27.3/29.2/82.1 |
| net arrival lateness ms p50/p90/p99/max | 22/26.4/28/71.3 | 26.7/31.7/33.2/67.6 | 21.9/26.7/28.3/83.3 | 22.6/27.2/29/82 |
| net inter-arrival ms p50/p90/p99/max | 25.8/41.9/45.1/72 | 26.2/41.9/45.2/62.8 | 26.3/42/45.4/80.7 | 25.6/42.1/45.8/78.2 |
| decode latency ms p50/p90/max | 0.1/0.2/3.2 | 0.1/0.2/1.8 | 0.1/0.2/1.5 | 0.1/0.2/2.1 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 23/23/0/0/0 | 25/24/0/0/0 | 26/26/0/0/0 | 23/23/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 16.4 (53.7) |
| audio late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 83.1 (54) |
| sync reference changes | 4 | 3 | 1 | 4 |
| element audio buffered ms p10/p50/p90 (poll) | 82.5/108.6/117.3 | 162.5/270.2/281.8 | 468.2/491.4/500.1 | 17.4/40.2/48.9 |
| catalog changes seen | 0 | 1 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 23.9 / 0 / 0 | 23.8 / 0.5 / 0 | 23.9 / 0 / 0 | 24 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 45.4 | 6/252, 2, 45.5 | 6/11, 1, 45.4 | 6/11, 1, 45.2 |
| worklet 100-quanta wall ms p50/max | 288.1/298.7 | 288.1/714.4 | 288.1/298.8 | 288.1/299.4 |
| window s | 54.7 | 54.4 | 55.2 | 54.8 |