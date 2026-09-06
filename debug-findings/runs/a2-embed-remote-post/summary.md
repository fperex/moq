| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/103/103 | 250/253/253 | 500/503/503 | 48.75/51.75/51.75 |
| ring target ms (last) |  |  |  |  |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 363 | 1.1 | 0 | 371 |
| underrun ms /min | 20870.1 | 5.8 | 0 | 39402.5 |
| underrun episode ms p50/p90/max | 56.6/97.3/149.5 | 5.3/5.3/5.3 | null/null/null | 107.9/151.4/200.7 |
| skips /min | 0 | 0 | 0 | 0 |
| skipped ms /min | 20396.9 | 3.2 | 0 | 36856.7 |
| skip ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| inserts into a dry ring % | 0 | 0 | 0 | 0 |
| buffered before insert ms p50/p90/min | null/null/null | null/null/null | null/null/null | null/null/null |
| media clock drift ms/s (insert / net) | -0.2 / 0.1 | 0.1 / 0.1 | 0.2 / 0.2 | 0.8 / 0.2 |
| insert arrival lateness ms p50/p90/p99/max | 132.3/202.7/249/288.6 | 115.7/182.8/214.5/238.7 | 114.4/179.5/212.2/228.7 | 173.8/340.2/451.2/536.4 |
| net arrival lateness ms p50/p90/p99/max | 111.8/173.7/205.9/260 | 114.9/178.7/207.9/236 | 113.4/176.4/207.4/225.5 | 115.3/173.4/203.2/240.4 |
| net inter-arrival ms p50/p90/p99/max | 0.5/136.9/198/235.3 | 0.1/138.1/200.7/220.3 | 0.1/137/200.4/224.4 | 1.8/133.1/193.4/220.8 |
| decode latency ms p50/p90/max | 3.3/12.6/221.6 | 3596.9/3690.7/3826.6 | 3738/3781.8/3816.1 | 11.2/199.5/412.8 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 2383/25/283/1/0 | 2376/0/0/0/0 | 1270/0/0/0/0 | 2363/23/830/14/0 |
| video late frames /min (max ms) | 5.4 (51.7) | 0 (null) | 0 (null) | 624.5 (47.4) |
| audio late frames /min (max ms) | 1178.2 (157.3) | 0 (null) | 0 (null) | 1837.6 (165.6) |
| sync reference changes | 91 | 4 | 0 | 212 |
| element audio buffered ms p10/p50/p90 (poll) | 0/24.7/94.3 | 35.3/139.8/203.7 | 270.8/375.3/445 | 0/0/46 |
| catalog changes seen | 0 | 0 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 23.9 / 0 / 0 | 0.3 / 0 / 0 | 0 / 0 / 0 | 23.8 / 1.4 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 45.6 | 6/11, 1, 44.8 | 6/11, 1, 44.7 | 6/11, 1, 45.5 |
| worklet 100-quanta wall ms p50/max | 288.2/300.1 | 288.1/305.8 | 288.1/301.9 | 288.2/314.9 |
| window s | 55.2 | 55.1 | 29.4 | 55.1 |