| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/126/126 | 250/253/253 | 500/503/503 | 20/46/46 |
| ring target ms (last) |  |  |  |  |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 0 | 372.5 |
| underrun ms /min | 0 | 0 | 0 | 764.8 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | null/null/null | 0.4/3.3/52.2 |
| skips /min | 0 | 0 | 0 | 0 |
| skipped ms /min | 6.4 | 9.6 | 3.2 | 755.8 |
| skip ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| inserts into a dry ring % | 0 | 0 | 0 | 0 |
| buffered before insert ms p50/p90/min | null/null/null | null/null/null | null/null/null | null/null/null |
| media clock drift ms/s (insert / net) | 0 / 0 | -0.5 / 0 | 0 / 0 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 22.6/27/28.4/52.6 | 35.4/49.3/54.3/111.8 | 23.1/27.7/29.5/69.4 | 22.2/26.7/28.6/79.9 |
| net arrival lateness ms p50/p90/p99/max | 22.6/26.9/28.3/52.5 | 27.4/32/34.3/103 | 23/27.6/29.3/69.5 | 22.1/26.6/28.4/79.8 |
| net inter-arrival ms p50/p90/p99/max | 25.4/42.4/46/48.5 | 25.7/42.4/46.4/101.3 | 26.2/42.4/46.3/69.7 | 25.6/42.4/46.1/78.4 |
| decode latency ms p50/p90/max | 0.1/0.2/1.8 | 0.1/0.2/1.1 | 0.1/0.2/2.2 | 0.1/0.2/2.9 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 23/23/0/0/0 | 25/25/0/0/0 | 26/26/0/0/0 | 23/23/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 10.9 (46.4) |
| audio late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 28.4 (49.7) |
| sync reference changes | 4 | 2 | 5 | 3 |
| element audio buffered ms p10/p50/p90 (poll) | 70.9/91.2/102.8 | 206.6/238.3/252.8 | 433.4/468.2/485.6 | 0/20.3/31.5 |
| catalog changes seen | 0 | 1 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 23.8 / 0 / 0 | 23.8 / 0.9 / 0 | 23.8 / 0 / 0 | 23.8 / 0 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 45.1 | 6/255, 3, 45.4 | 6/11, 1, 45.3 | 6/11, 1, 45.2 |
| worklet 100-quanta wall ms p50/max | 288.1/298.9 | 288.1/751.4 | 288.1/298.9 | 288.1/298.8 |
| window s | 54.7 | 54.4 | 55.2 | 54.9 |