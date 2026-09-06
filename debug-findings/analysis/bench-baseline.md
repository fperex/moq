# Phase B benchmark: baseline (refactored tree, all flags off)

Same code as upstream in behaviour (splits only). Cells: underrun episodes/min / silence ms/min / discarded ms/min @resolved delay ms.

| scenario | preset | baseline |
|---|---|---|
| local-fmp4-iso | auto | 366.5 / 812 / 802 @46 |
| local-fmp4-iso | 100ms | 0 / 0 / 3 @126 |
| local-fmp4-iso | 250ms | 0 / 0 / 3 @253 |
| local-fmp4-iso | 500ms | 0 / 0 / 3 @503 |
| local-fmp4-post | auto | 372.5 / 765 / 756 @46 |
| local-fmp4-post | 100ms | 0 / 0 / 6 @126 |
| local-fmp4-post | 250ms | 0 / 0 / 10 @253 |
| local-fmp4-post | 500ms | 0 / 0 / 3 @503 |
| local-ts-post | auto | 354.7 / 43722 / 194 @46 |
| local-ts-post | 500ms | 0 / 0 / 6 @526 |
| remote-post | auto | 367.7 / 39946 / 36028 @51.75 |
| remote-post | 100ms | 360.2 / 21087 / 20518 @103 |
| remote-post | 250ms | 3.3 / 147 / 150 @253 |
| remote-post | 500ms | 0 / 0 / 6 @503 |
| ownpub-remote | auto | 86.3 / 2576 / 0 @70.5 |
| ownpub-remote | 500ms | 271 / 31504 / 0 @523 |

cells: underrun episodes/min / silence ms/min / discarded ms/min @resolved delay ms
