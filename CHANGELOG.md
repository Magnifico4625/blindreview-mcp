# Changelog

## 0.3.0 — evaluation / benchmark upgrade

No new product features; the MCP tool surface (`review_decision` with `blind_first | proposal_first`, `should_review`, `record_outcome`) is unchanged.

- Prompts of `proposal_first`, `proposal_first_2pass`, `blind_first` (and the repair prompt) are frozen by hash (`tests/prompt-freeze.test.ts`); new prompts only as new named modes.
- New benchmark-only modes: `independent_only` (blind position, then a fresh-session comparer that never sees the transcript) and `decision_judge` (separate critic-bias experiment).
- New case schema with ground truth physically separate from the reviewer input (`benchmark/cases/`, one file per case); 25 cases (12 adapted from public postmortems/incidents/engineering writeups, 13 synthetic), 13 flawed / 12 correct.
- Leak tests: no `source` / `ground_truth` / `diagnostics` text reaches any provider request in any mode.
- Metrics: decision accuracy (successful and strict), KEEP on correct, defect detection, exact verdict, false / severe false intervention, insufficient-evidence rate, tokens and latency (mean/median), relative cost; keyword hit-rate as diagnostic only.
- Statistics: Wilson CIs, paired case-bootstrap differences, pre-registered signal labels (`benchmark/thresholds.ts`).
- Failure accounting (expected / successful / failed / reasons), logged retries for transient errors.
- Full external config via CLI flags and env; results under `benchmark-results/<label>/` with model, config, git SHA, case-set hash and prompt hashes.
- Checkpoint file per label and `--resume` for interrupted runs; `--max-rpm` throttle and `--stop-on-rate-limit` for rate-limited free models.
- Human review sheet export (mode-blinded CSV) and ingest script; `benchmark:compare` for side-by-side labels.

## 0.2.0

Fix pass: token near-hard cap, OUTPUT_TRUNCATED / INTERNAL_ERROR / BLINDNESS_LEAK, config validation, benchmark v1 with `proposal_first_2pass` control.

## 0.1.0

Initial MVP.
