| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/103/103 | 250/253/253 | 500/503/503 | 58.75/61.75/61.75 |
| ring target ms (last) |  |  |  |  |
| chunk ms | 23.2 | 23.2 | 23.2 | 23.2 |
| underrun episodes /min | 0 | 0 | 0 | 0 |
| underrun ms /min | 0 | 0 | 0 | 0 |
| underrun episode ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| skips /min | 0 | 0 | 0 | 0 |
| skipped ms /min | 14231.2 | 248 | 0 | 2722.2 |
| skip ms p50/p90/max | null/null/null | null/null/null | null/null/null | null/null/null |
| inserts into a dry ring % | 0 | 0 | 0 | 0 |
| buffered before insert ms p50/p90/min | null/null/null | null/null/null | null/null/null | null/null/null |
| media clock drift ms/s (insert / net) | 0.3 / 0.1 | -71 / 0.1 | 0 / 0 | 0 / 0 |
| insert arrival lateness ms p50/p90/p99/max | 125.6/194/242.4/308.3 | 1685.3/3252/3633.1/3957.6 | 109.2/175.8/209.3/235.4 | 142.4/231.6/364.4/459.1 |
| net arrival lateness ms p50/p90/p99/max | 111.7/173.6/204.6/221.8 | 114.5/179.2/210.6/409.9 | 108.4/172.4/204.6/227.8 | 108.1/170.9/202.3/230.8 |
| net inter-arrival ms p50/p90/p99/max | 0.4/135.8/200.5/230.6 | 0.1/136.5/199.6/412.7 | 0.1/138.5/197.2/220.4 | 1.4/136.8/194.1/790142.7 |
| decode latency ms p50/p90/max | 2.9/11.5/247.3 | 3556/3639.1/3957.9 | 3596.3/3658.8/3798.5 | 5.7/149.3/405.5 |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 2378/25/293/2/0 | 2380/27/7/0/0 | 2383/23/0/0/0 | 3818/39/1412/34/0 |
| video late frames /min (max ms) | 1.1 (19) | 0 (null) | 0 (null) | 29.4 (400.2) |
| audio late frames /min (max ms) | 1079.5 (110.5) | 8.7 (152.3) | 0 (null) | 142.4 (147.5) |
| sync reference changes | 210 | 23 | 1 | 702 |
| element audio buffered ms p10/p50/p90 (poll) | 0/47.9/108.8 | 0/145.6/215.3 | 294/407.2/471.1 | 0/9.5/75 |
| catalog changes seen | 0 | 0 | 0 | 1 |
| rendered fps / audio stalled % / video stalled % | 23.8 / 28.6 / 0 | 23.8 / 0.5 / 0 | 23.9 / 0 / 0 | 1.5 / 53.3 / 1.1 |
| worklet read gap ms p50/max, burst quanta max, burst % | 6/11, 1, 44.9 | 6/11, 1, 44.7 | 6/11, 1, 44 | 6/253, 3, 45.1 |
| worklet 100-quanta wall ms p50/max | 288.2/306.3 | 288.1/301.6 | 288.2/300.7 | 288.1/790638 |
| window s | 55.2 | 55.2 | 55.2 | 879.5 |