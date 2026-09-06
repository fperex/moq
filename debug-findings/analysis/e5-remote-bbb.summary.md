| metric | 100ms | 250ms | 500ms | auto |
|---|---|---|---|---|
| resolved jitter/delay/maxAge ms | 100/103/103 | 250/253/253 | 500/503/503 | 57.5/60.5/60.5 |
| ring target ms (last) | 103 | 253 | 503 |  |
| chunk ms | 23.2 | 23.2 | 23.2 |  |
| underrun episodes /min | 365.8 | 3.3 | 0 | 0 |
| underrun ms /min | 21494.1 | 30 | 0 | 0 |
| underrun episode ms p50/p90/max | 56.6/94.4/126.3 | 11.1/11.1/11.1 | null/null/null | null/null/null |
| skips /min | 378.9 | 6.5 | 2.2 | 0 |
| skipped ms /min | 20546 | 33.1 | 3.2 | 0 |
| skip ms p50/p90/max | 59.5/59.5/82.7 | 5.8/8.7/8.7 | 2.9/2.9/2.9 | null/null/null |
| inserts into a dry ring % | 14 | 0.1 | 0 |  |
| buffered before insert ms p50/p90/min | 69.7/139.3/0 | 119.5/189.2/0 | 369.5/439.2/247.6 | null/null/null |
| media clock drift ms/s (insert / net) | 0.1 / 0 | 0 / 0 | 0.1 / 0.1 | null / null |
| insert arrival lateness ms p50/p90/p99/max | 109.9/178.2/210.5/258.7 | 115.1/182.3/214.5/245.7 | 112.3/179.3/211.5/232.3 | null/null/null/null |
| net arrival lateness ms p50/p90/p99/max | 106.9/171.9/199.9/220.7 | 114.7/180.5/213.2/243.9 | 111.6/177.8/210.2/230.3 | null/null/null/null |
| net inter-arrival ms p50/p90/p99/max | 0.2/142.3/200.6/227.2 | 0.1/139.6/204.3/241.6 | 0.1/139.3/205.3/236 | null/null/null/null |
| decode latency ms p50/p90/max | 0.7/4.6/210.3 | 4059.2/4112.5/4247.4 | 3744.8/3803.2/3931.3 | null/null/null |
| pub->watch ms p50/p90/p99/max | null/null/null/null | null/null/null/null | null/null/null/null | null/null/null/null |
| audio groups / video groups / group skips / net stale / errs | 2365/23/210/3/0 | 2374/23/0/0/0 | 2375/24/0/0/0 | 0/0/0/0/0 |
| video late frames /min (max ms) | 0 (null) | 0 (null) | 0 (null) | 0 (null) |
| audio late frames /min (max ms) | 1010.4 (113.9) | 0 (null) | 0 (null) | 0 (null) |
| sync reference changes | 222 | 1 | 0 | 0 |
| element audio buffered ms p10/p50/p90 (poll) | 0/0.1/0.2 | 0/0.2/0.2 | 0.3/0.4/0.5 | 0/0/0 |
| catalog changes seen | 0 | 0 | 0 | 0 |
| rendered fps / audio stalled % / video stalled % | 23.9 / 0.5 / 0 | 24 / 0 / 0 | 24 / 0 / 0 | null / 100 / 100 |
| worklet 100-quanta wall ms p50/max | 288.1/300.1 | 288.1/299.1 | 288.1/298.8 | 289/300.4 |
| window s | 55.1 | 55.1 | 55.1 | 55 |