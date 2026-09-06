| metric | 1000ms | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 1000/1003/1003 | 100/103/103 | 250/253/253 | 500/503/503 | 20/46/46 |
| ring target ms (last) | 1003 | 103 | 253 | 503 | 46 |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 0 | 0 | 313.8 |
| underrun ms /min | 0 | 0 | 0 | 0 | 690.7 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null | 0.4/3.3/52.2 |
| skips /min | 0.7 | 5.7 | 8.5 | 0.7 | 308.1 |
| skipped ms /min | 2 | 186.7 | 24.8 | 2 | 690.7 |
| skip ms p50/p90/max | 2.9/2.9/2.9 | 8.7/222.1/222.1 | 2.9/2.9/2.9 | 2.9/2.9/2.9 | 0.4/5.8/20.7 |
| inserts into a dry ring % | 0 | 0 | 0 | 0 | 19.8 |
| buffered before insert ms p50/p90/min | 956.6/971.1/921.7 | 76.7/94.1/15.7 | 206.6/224/148.5 | 456.6/471.1/404.3 | 5.8/23.2/0 |
| media clock drift ms/s (insert / net) | 0 / 0 | 14.8 / 0 | -0.5 / -0.5 | 0 / 0 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 23.7/28.5/30.4/54.4 | 636.9/1139.2/2459.2/2481.7 | 24.5/34.2/38.5/87.6 | 22.3/27/29.4/72.7 | 21.9/26.6/28.9/77.5 |
| net arrival lateness ms p50/p90/p99/max | 23.6/28.4/30.1/54.4 | 28.8/33.5/36.2/2517.1 | 24.5/34.2/38.5/87.5 | 22.3/26.9/29.2/72.6 | 21.8/26.5/28.6/77.4 |
| net inter-arrival ms p50/p90/p99/max | 26.1/42.1/46.5/63.9 | 24.9/42.4/46.3/81.4 | 25.5/42.2/45.9/78.7 | 25.6/42.2/46.6/69.6 | 25.3/42.3/45.9/75.9 |
| decode latency ms p50/p90/max | 0.1/0.2/2.9 | 0.1/1/2490.4 | 0.1/0.2/4 | 0.1/0.2/3.2 | 0.1/0.2/2.3 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 42/42/0/0/0 | 40/38/1/14/0 | 40/40/0/0/0 | 38/38/0/0/0 | 36/36/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 0 (null) | 18.4 (41.7) |
| audio late frames /min (max ms) | 0 (null) | 0.7 (2427) | 0 (null) | 0 (null) | 125.1 (49.5) |
| sync reference changes | 3 | 1 | 25 | 4 | 4 |
| element audio buffered ms p10/p50/p90 (poll) | 1/1/1 | 0/0.1/0.1 | 0.2/0.2/0.3 | 0.5/0.5/0.5 | 0/0/0 |
| catalog changes seen | 0 | 0 | 0 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 23.9 / 0 / 0 | 23.9 / 0.3 / 0 | 24 / 0 / 0 | 23.9 / 0 / 0 | 24 / 0 / 0 |
| worklet 100-quanta wall ms p50/max | 288.1/299 | 288.1/874.9 | 288.1/298.8 | 288.1/298.9 | 288.1/298.8 |
| window s | 85.2 | 84.4 | 84.4 | 85.2 | 84.9 |