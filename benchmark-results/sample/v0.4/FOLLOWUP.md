# v0.4.0 follow-up: tempting-correct cases — followup-glm-5.3-flash

Model `z-ai/glm-5.3-flash` · case set 7129cfd34e8f24c6 · 3 run(s) · git d1d9bc2776. All cases are correct; FI = MODIFY/REPLACE rate over successful runs; Wilson 95% CIs (optimistic: runs of a case are correlated).

| mode | FI | WARNING | KEEP | INSUFFICIENT_EVIDENCE | failed | cost |
|---|---|---|---|---|---|---|
| evidence_gate | 0/27 (0%, CI 0-13%) | 0/27 (0%, CI 0-13%) | 27/27 (100%, CI 88-100%) | 0 | 0/27 | $0.0270 |
| decision_judge | 2/26 (8%, CI 2-24%) | 0/26 (0%, CI 0-13%) | 24/26 (92%, CI 76-98%) | 0 | 1/27 (TIMEOUT) | $0.0337 |

## evidence_gate: gate

- Claims: 0/27; model said "confirmed": 0; validated: 0; **downgraded: 0**; MODIFY/REPLACE forced to WARNING: 0.
- Ungated counterfactual (model's own verdict): FI 0/27 (0%, CI 0-13%).
- Interventions that passed the gate (all false, since every case is correct): 0. POST-HOC, not pre-registered: on a correct case no artifact can demonstrate a real defect, so each of these is an irrelevant-artifact validation (known search_hit limitation).

## Per case

| case | evidence_gate | decision_judge |
|---|---|---|
| allowlisted-order-by | KEEP KEEP KEEP | KEEP KEEP FAIL |
| best-effort-telemetry | KEEP KEEP KEEP | MODIFY KEEP MODIFY |
| float-average-display | KEEP KEEP KEEP | KEEP KEEP KEEP |
| loose-email-check | KEEP KEEP KEEP | KEEP KEEP KEEP |
| md5-cache-key | KEEP KEEP KEEP | KEEP KEEP KEEP |
| sequential-idp-deletes | KEEP KEEP KEEP | KEEP KEEP KEEP |
| serialized-debit | KEEP KEEP KEEP | KEEP KEEP KEEP |
| sync-config-read-cli | KEEP KEEP KEEP | KEEP KEEP KEEP |
| validate-at-boundary-only | KEEP KEEP KEEP | KEEP KEEP KEEP |

## Pre-registered follow-up criterion (section 8)

- Temptation check: decision_judge FI 2/26 (8%, CI 2-24%) — **failed (< 30%): the set is not tempting, result inconclusive by construction**.
- evidence_gate FI 0/27 (0%, CI 0-13%) (alive < 20%, archive ≥ 40%).
- Failed reviews: evidence_gate 0%, decision_judge 4% (limit 10%).

**Verdict: inconclusive (set not tempting)**
