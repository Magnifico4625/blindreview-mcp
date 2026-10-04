# Changelog

## 0.4.0 — Decision Judge → Evidence Gate (final architectural experiment)

Benchmark-only experiment; the MCP tool surface is unchanged and v0.3.0 modes/prompts are untouched (hash-frozen).

- New benchmark mode `evidence_gate`: one judge with read-only, sandboxed tools over a repo snapshot (`search`, `find_symbol`, `read_file`, `inspect_config`, allowlisted `run_test`, `typecheck`), hard caps (8 tool calls, 80k tokens/review, timeouts, output caps), no edits, no arbitrary commands, child processes without API keys. Tool calling via OpenRouter (`src/evidence/`).
- Harness-validated claims: "confirmed" counts only with a cited artifact from the same session (failing test, typecheck error, or search hit outside the patch's own lines); otherwise downgraded. MODIFY/REPLACE only with validated confirmation, else WARNING.
- 20 repo-snapshot cases (`benchmark/repo-cases/`): 8 mechanically confirmable defects (3 test, 3 typecheck, 2 search), 3 untestable defects, 9 correct. Labels verified mechanically by tests; ground truth outside the snapshot, leak tests.
- Runner with cost tracking (OpenRouter `usage.cost`), shared spend ledger with hard stop, checkpoint/`--resume`; metrics (testable vs untestable recall, FI, WARNING rate, downgrades, ungated counterfactual), cross-model summary with a post-hoc evidence-relevance audit.
- Pre-registered criteria committed before any run (`docs/v0.4-evidence-gate.md`, `benchmark/evidence/criteria.ts`).
- Results (z-ai/glm-5.3-flash, qwen/qwen3.8-flash; 5 runs; total spend ≈ $0.80): glm → **continue** (testable recall 95%, FI 0%); qwen → **inconclusive (failures)** (11% upstream HTTP 429 failures; successful runs: recall 100%, FI 0%). Project verdict: **inconclusive**.
- Caveat: on the new cases the decision_judge baseline already has low FI (glm 5%, qwen 14%; 16% before the qwen resume) vs ~61% in v0.3, so the correct cases may not be tempting enough, and evidence_gate's 0% FI is not strong proof that the gate itself removed false interventions. The clearer effect is higher recall on typecheck/search defects. The cost is a collapse of recall on untestable defects (glm 20%, qwen 8%), which mostly end as WARNING, largely by the model's own choice; the harness forced only 2. Post-hoc: the 4 validated interventions on untestable cases relied on irrelevant search hits.

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
