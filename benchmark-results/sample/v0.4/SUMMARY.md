# v0.4.0 evidence_gate — cross-model summary

| label | model | runs | case set | git |
|---|---|---|---|---|
| main-glm-5.3-flash | z-ai/glm-5.3-flash | 5 | 2239b07cb5552217 | b716159251 |
| main-qwen3.8-flash | qwen/qwen3.8-flash | 5 | 2239b07cb5552217 | e0d03d3800 |
| pf-glm-5.3-flash | z-ai/glm-5.3-flash | 1 | 2239b07cb5552217 | 0da85e980a dirty |

| model | mode | recall testable | recall untestable | FI on correct | WARNING on correct | failed | cost total | cost/review |
|---|---|---|---|---|---|---|---|---|
| z-ai/glm-5.3-flash | evidence_gate | 95% [84–99] (38/40) | 20% [7–45] (3/15) | 0% [0–8] (0/45) | 2% [0–12] (1/45) | 0/100 | $0.2003 | $0.00200 |
| z-ai/glm-5.3-flash | decision_judge | 62% [46–75] (24/39) | 100% [80–100] (15/15) | 5% [1–16] (2/43) | 0% [0–8] (0/43) | 3/100 | $0.1578 | $0.00158 |
| qwen/qwen3.8-flash | evidence_gate | 100% [91–100] (40/40) | 8% [2–35] (1/12) | 0% [0–9] (0/37) | 3% [1–14] (1/37) | 11/100 | $0.1019 | $0.00102 |
| qwen/qwen3.8-flash | decision_judge | 84% [70–93] (32/38) | 100% [79–100] (14/14) | 14% [6–29] (5/35) | 0% [0–10] (0/35) | 13/100 | $0.1611 | $0.00161 |
| z-ai/glm-5.3-flash | proposal_first | 75% [41–93] (6/8) | 100% [44–100] (3/3) | 11% [2–44] (1/9) | 0% [0–30] (0/9) | 0/20 | $0.0204 | $0.00102 |

## evidence_gate gate statistics

| model | claims | claimed confirmed | validated | downgraded (correct / flawed) | forced to WARNING (correct / flawed) | ungated FI | ungated recall testable | criterion |
|---|---|---|---|---|---|---|---|---|
| z-ai/glm-5.3-flash | 51 | 43 | 41 | 2 (0 / 2) | 0 / 2 | 0% [0–8] (0/45) | 95% [84–99] (38/40) | **continue** |
| qwen/qwen3.8-flash | 53 | 41 | 41 | 0 (0 / 0) | 0 / 0 | 0% [0–9] (0/37) | 100% [91–100] (40/40) | **inconclusive (failures)** |

## POST-HOC evidence relevance audit (not pre-registered)

A validated claim counts as relevant only if a matched artifact actually demonstrates the case's ground-truth defect (failing test / typecheck error / search hit in the file that contradicts the proposal). 'Audited' rates treat interventions validated only by irrelevant artifacts as WARNING.

| model | validated | relevant | validated but irrelevant (testable / untestable / correct) | audited recall testable | audited recall untestable | audited FI |
|---|---|---|---|---|---|---|
| z-ai/glm-5.3-flash | 41 | 38 | 0 / 3 / 0 | 95% [84–99] (38/40) | 0% [0–20] (0/15) | 0% [0–8] (0/45) |
| qwen/qwen3.8-flash | 41 | 40 | 0 / 1 / 0 | 100% [91–100] (40/40) | 0% [0–24] (0/12) | 0% [0–9] (0/37) |

## Paired comparisons

- z-ai/glm-5.3-flash: evidence_gate vs decision_judge: FI reduction +5 pp [+0, +15], testable recall loss -33 pp [-62, -8], untestable recall loss +80 pp [+40, +100]
- qwen/qwen3.8-flash: evidence_gate vs decision_judge: FI reduction +14 pp [+0, +43], testable recall loss -16 pp [-37, +0], untestable recall loss +92 pp [+75, +100]

**Pre-registered project verdict: inconclusive** (per-model labels: continue, inconclusive (failures))

Cost of the summarized runs: $0.6414
Ledger total (all v0.4.0 runs incl. pilot and failed attempts): $0.6781 — pilot-qwen3.8-flash $0.0103, pilot-glm-5.3-flash $0.0122, pilot2-glm-5.3-flash $0.0054, main-qwen3.8-flash $0.2718, main-glm-5.3-flash $0.3580, pf-glm-5.3-flash $0.0204

