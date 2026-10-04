# mimo-v2.6-flash — partial run, stopped by the user (2026-10-04)

The full v0.3.0 run of `xiaomi/mimo-v2.6-flash` (25 cases × 5 modes × 3 runs = 375 reviews, concurrency 4, same config as the other labels: reasoning_effort medium, 6000 tokens/call, 24000/review, timeout 240 s, seed 42) was **killed at 257/375 reviews** on the user's instruction (paid model). This process predates the checkpoint feature, so only its stdout log survives: `partial-run.stdout.txt` (verdict, tokens, latency per review; no review text).

Counts below are tallied from that log, over the reviews that finished; cases and runs are **not balanced** across modes (mode order was shuffled and the run stopped mid-way), so no CIs or pre-registered labels are computed. Not comparable to a full report; for orientation only.

| Mode | finished | failed | decision accuracy | KEEP on correct | defect detection | REPLACE on correct | avg tokens |
|---|---|---|---|---|---|---|---|
| proposal_first | 53 | 0 | 29/53 | 0/24 | 29/29 | 0 | 1897 |
| proposal_first_2pass | 51 | 0 | 28/51 | 1/24 | 27/27 | 0 | 4532 |
| blind_first | 48 | 2 | 33/48 | 7/22 | 26/26 | 0 | 4902 |
| independent_only | 49 | 2 | 29/49 | 3/23 | 26/26 | 0 | 4687 |
| decision_judge | 52 | 0 | 43/52 | 15/24 | 28/28 | 0 | 2011 |

Failures: 4 (2× OUTPUT_TRUNCATED, 2× MALFORMED_RESPONSE); 2 transient TIMEOUT retries (both succeeded).
