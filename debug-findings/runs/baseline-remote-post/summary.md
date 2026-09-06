| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/103/103 | 250/253/253 | 500/503/503 | 48.75/51.75/51.75 |
| ring target ms (last) |  |  |  |  |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 360.2 | 3.3 | 0 | 367.7 |
| underrun ms /min | 21086.8 | 146.6 | 0 | 39945.9 |
| underrun episode ms p50/p90/max | 56.6/97.3/126.3 | 31.4/98.2/98.2 | null/null/null | 107.9/151.4/177.5 |
| skips /min | 0 | 0 | 0 | 0 |
| skipped ms /min | 20518.3 | 149.8 | 6.3 | 36027.8 |
| skip ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| inserts into a dry ring % | 0 | 0 | 0 | 0 |
| buffered before insert ms p50/p90/min | null/null/null | null/null/null | null/null/null | null/null/null |
| media clock drift ms/s (insert / net) | 0.3 / 0.2 | 0.1 / 0.1 | -0.1 / -0.1 | 2.1 / 0.2 |
| insert arrival lateness ms p50/p90/p99/max | 130.4/199.5/246.9/298.4 | 112.3/179.3/213.5/325.2 | 108.4/175.4/206.2/236.2 | 184.1/303.2/435.9/549.8 |
| net arrival lateness ms p50/p90/p99/max | 112.8/177.9/211/249.4 | 111.7/177.2/211.6/323.4 | 108.3/173.8/205.4/232.7 | 112.7/177.6/213.2/237.5 |
| net inter-arrival ms p50/p90/p99/max | 0.2/139/201.3/221 | 0.1/140.8/200.1/331.2 | 0.1/143.3/198.8/231.1 | 0.7/141.2/202.6/218.9 |
| decode latency ms p50/p90/max | 1.9/11.6/230.6 | 3581.2/3630.4/3776.5 | 3620/3762.1/3838.1 | 4.3/185.5/531.8 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 2375/25/265/0/0 | 2384/26/0/0/0 | 2372/26/0/0/0 | 2345/23/751/27/0 |
| video late frames /min (max ms) | 9.8 (79.4) | 1.1 (24.9) | 0 (null) | 639.6 (91.8) |
| audio late frames /min (max ms) | 1168.8 (137.5) | 5.4 (69.4) | 0 (null) | 1577.2 (175.4) |
| sync reference changes | 121 | 3 | 1 | 380 |
| element audio buffered ms p10/p50/p90 (poll) | 0/30.5/92.9 | 12.1/142.7/209.5 | 270.8/389.8/450.8 | 0/0/40.2 |
| catalog changes seen | 0 | 0 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 23.8 / 0 / 0 | 23.9 / 0 / 0 | 23.8 / 0 / 0 | 23.8 / 0.9 / 0 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 44.6 | 6/11, 1, 45.1 | 6/11, 1, 44.9 | 6/11, 1, 45 |
| worklet 100-quanta wall ms p50/max | 288.1/307.8 | 288.1/307.2 | 288.1/298.9 | 288.1/311 |
| window s | 55.1 | 55.2 | 55.2 | 55.2 |