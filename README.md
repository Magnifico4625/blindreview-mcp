# BlindReview MCP

**One independent, blind-first reviewer for the expensive decisions of AI coding agents.**

> Spend extra inference before expensive implementation.
> Independent first. Compare second.

[![CI](https://github.com/Magnifico4625/blindreview-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Magnifico4625/blindreview-mcp/actions/workflows/ci.yml)

## Problem

AI coding agents commit to the first plausible solution too early. When the decision is expensive (an architecture choice, a schema migration, a public API change, a dependency swap, a big refactor) a wrong first idea costs days of rework, data loss or an outage. Asking a second model to "review this plan" helps less than it should: once the reviewer reads the author's solution it gets **anchored** on its framing and mostly polishes it.

## Hypothesis

An independent reviewer that **first reasons about the problem without seeing the author's solution**, and only then compares it with the revealed proposal, catches fundamental errors that ordinary critique misses because of anchoring.

This repo is a research MVP to test that hypothesis cheaply, with an A/B harness (`blind_first` vs `proposal_first`).

## What it is

An MCP server with one main tool, `review_decision`, that adds **exactly one** extra reviewer before an expensive decision:

```
Main agent ──► Phase 1: blind independent review (no proposal) ──► Phase 2: reveal proposal, compare ──► compact verdict
```

1. **Phase 1 (blind).** The reviewer receives only `objective`, `constraints`, `context`, `environment`, `evidence`, `decision_type`, `risk_level`. The `proposed_solution` is physically absent from the request (enforced by types and tests). It produces an internal independent position: assumptions, several directions, failure modes, preferred solution, assumptions to test.
2. **Phase 2 (reveal).** In the same session (Phase 1 messages + Phase 1 answer + reveal) the proposal is shown and compared against the reviewer's own position.
3. **Verdict.** A compact typed JSON result (`KEEP | MODIFY | REPLACE | INSUFFICIENT_EVIDENCE`, risks, optional better alternative, the cheapest falsification probe, confidence). The Phase 1 position, chain-of-thought and transcript are **not** returned. Session state is discarded after the call.

## What it is NOT

- Not a swarm, not multi-agent debate, no voting, no rounds.
- Not an autonomous team or an orchestration framework.
- Not a replacement for your coding agent.
- Not a generic "Sequential Thinking" clone.

Hard invariants: exactly 1 main agent + 1 reviewer; no recursive agents. Recursion is **structurally impossible** rather than guarded at runtime: the provider interface has no `tools` field, requests never carry tools, tool calls in a model answer are never executed (the answer is treated as unusable), and there is one call path to the model (`ReviewSession`). The reviewer therefore cannot call `review_decision`, spawn reviewers or delegate.

### Blindness contract

The blind fields (`objective`, `constraints`, `context`, `environment`, `evidence`) are written by the calling agent, so the agent's plan can leak into them. The contract:

- The tool and field descriptions tell the agent to describe the **problem** there and put the plan **only** in `proposed_solution`.
- `decision_type` and `risk_level` are visible to Phase 1 by design.
- A deterministic check measures how much of `proposed_solution` is already present in the blind fields: the share of its word 5-grams (shingles) that also occur there (containment; short proposals use n = their word count).
  - `>= BLINDNESS_WARN_THRESHOLD` (default 0.15): the review runs and `meta.blindness_warning` says the blind phase may have seen part of the plan.
  - `>= BLINDNESS_LEAK_THRESHOLD` (default 0.5): `blind_first` **refuses** with `BLINDNESS_LEAK` before any model call (no tokens spent). We refuse rather than silently downgrade to a non-blind review, so that a blind_first result always means the blind phase was (lexically) blind. `proposal_first` only gets the warning.
- This catches copy-paste and close paraphrase only; a reworded plan in `context` is not detected.

## Install

Requires Node.js **>= 20.12** (Windows 11, macOS, Linux).

```bash
git clone https://github.com/Magnifico4625/blindreview-mcp.git
cd blindreview-mcp
npm ci
npm run build
npm test
```

Then configure (below) and start it (an MCP client normally starts it for you):

```bash
npm start
```

The server speaks MCP over stdio; it logs only to stderr. In MCP client configs launch `node dist/src/server.js` directly, not `npm start` (npm prints a banner to stdout, which corrupts the protocol stream).

## Configuration (`.env`)

Invalid values (e.g. a `REVIEWER_BASE_URL` without `http(s)://`, a non-numeric limit, a typo in a boolean) fail at startup with an error naming the variable. There is no `MAX_TOOL_CALLS`: the reviewer has no tools, so there is nothing to budget.

Copy `.env.example` to `.env` in the repo root (`copy .env.example .env` on Windows cmd, `cp .env.example .env` elsewhere). The server loads `<repo>/.env` itself (no dependency, independent of the working directory the MCP client uses); variables passed by the MCP client's `env` block take precedence. Set `BLINDREVIEW_ENV_FILE` to use a different file.

| Variable | Default | Meaning |
|---|---|---|
| `REVIEWER_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible `/chat/completions` base URL |
| `REVIEWER_API_KEY` | – | API key (omit for local servers) |
| `REVIEWER_MODEL` | `gpt-5-mini` | Reviewer model id |
| `REVIEWER_REASONING_EFFORT` | – | `low` / `medium` / `high`; dropped automatically if the API rejects it |
| `REVIEWER_REASONING_PARAM` | auto | `reasoning_effort` (OpenAI/xAI) or `reasoning_object` (OpenRouter `reasoning: {effort}`); auto-detected from the URL |
| `REVIEWER_MAX_TOKENS` | `4000` | Max completion tokens per call |
| `REVIEWER_TEMPERATURE` | – | Optional 0..2; not sent when empty, dropped automatically if rejected |
| `MAX_REVIEW_TOKENS` | `20000` | Near-hard cap on cumulative tokens (prompt + completion) across all phases, see budget policy |
| `BLINDNESS_LEAK_THRESHOLD` | `0.5` | Proposal/blind-field 5-gram containment at which blind_first refuses (`BLINDNESS_LEAK`) |
| `BLINDNESS_WARN_THRESHOLD` | `0.15` | Containment at which `meta.blindness_warning` is set |
| `REVIEW_TIMEOUT` | `120000` | Timeout for the whole review in ms (AbortController) |
| `TELEMETRY_ENABLED` | `false` | Opt-in local JSONL telemetry. Booleans accept true/false, 1/0, yes/no, on/off; anything else is a startup error |
| `TELEMETRY_PATH` | `./data/reviews.jsonl` | Relative paths resolve against the repo root |

### Choosing a reviewer model

Use a strong model, ideally from a **different family** than your main agent (different blind spots). Examples:

| Provider | `REVIEWER_BASE_URL` | `REVIEWER_MODEL` (example) |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-5-mini`, `gpt-5` |
| OpenRouter | `https://openrouter.ai/api/v1` | `xiaomi/mimo-v2.6-flash`, `openai/gpt-5-mini`, any id from `https://openrouter.ai/api/v1/models` |
| xAI | `https://api.x.ai/v1` | a current Grok model id from the xAI console, e.g. `grok-4` |
| Ollama (local) | `http://localhost:11434/v1` | e.g. `qwen3:14b` (no key needed) |
| LM Studio (local) | `http://localhost:1234/v1` | the model id shown in LM Studio's server tab |

The adapter asks for JSON (`response_format: json_object`) and, when servers reject parameters, retries once without them: `reasoning_effort`/`reasoning` is dropped, `max_tokens` becomes `max_completion_tokens` (newer OpenAI reasoning models), `response_format` is dropped. `<think>` blocks and Markdown fences are stripped before parsing.

## Connecting to MCP clients

Use the absolute path to `dist/src/server.js` in your clone. Put secrets in `.env` (or in the client's `env` block).

**Claude Code**

```bash
claude mcp add blindreview -- node /abs/path/blindreview-mcp/dist/src/server.js
```

**Cursor** – `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "blindreview": {
      "command": "node",
      "args": ["/abs/path/blindreview-mcp/dist/src/server.js"]
    }
  }
}
```

**Claude Desktop** – `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), same `mcpServers` shape as Cursor.

**VS Code** – `.vscode/mcp.json`:

```json
{
  "servers": {
    "blindreview": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/blindreview-mcp/dist/src/server.js"]
    }
  }
}
```

**Windows 11 example** (escape backslashes in JSON; an absolute `node.exe` path avoids PATH issues in GUI apps):

```json
{
  "mcpServers": {
    "blindreview": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\you\\code\\blindreview-mcp\\dist\\src\\server.js"],
      "env": { "REVIEWER_API_KEY": "sk-..." }
    }
  }
}
```

Note: on Windows, MCP servers launched via `npx` usually need `"command": "cmd", "args": ["/c", "npx", ...]` because `npx` is a `.cmd` shim. This repo is not published to npm; launch it with `node` as above.

## Tools

### `review_decision`

Input:

```jsonc
{
  "objective": "string",
  "constraints": ["string"],
  "context": "string",
  "proposed_solution": "string",            // hidden from the reviewer until phase 2 (blind_first)
  "decision_type": "architecture|refactor|debugging|database|api|dependency|performance|security|implementation|other",
  "risk_level": "low|medium|high|critical",
  "review_mode": "blind_first|proposal_first", // optional, default blind_first; proposal_first = control (plain critique)
  "environment": "string",                   // optional
  "evidence": ["string"]                     // optional: logs, numbers, test output
}
```

Output example (real blind_first output for the v0 `authz-cache-ttl` case, lists truncated with "…"):

```json
{
  "verdict": "MODIFY",
  "recommendation": "Keep the read-through Redis cache direction but drop the 15-minute TTL with no invalidation: replace it with a 2-minute TTL plus a Kafka consumer on 'permission.changed' that deletes affected keys. Do not cache negative decisions (denials) for write/admin actions — either bypass the cache for non-read actions or use a much shorter TTL. This preserves the ~78% hit rate at 2 minutes while making revocation lag bounded and demonstrably SOC 2 compliant.",
  "critical_assumptions": [
    "SOC 2 permits up to 15 minutes of stale grants for terminated employees — 'promptly' is almost certainly stricter than this.",
    "…"
  ],
  "material_risks": [
    "15-minute stale grant for a terminated employee directly violates the SOC 2 revocation requirement — the most likely reason this gets rejected in audit or causes a real incident.",
    "…"
  ],
  "falsification_probe": {
    "description": "Ask the compliance/owning team for the documented maximum acceptable revocation delay for terminated employees (SOC 2 control text or internal policy), and simultaneously run a 1-day shadow test: apply cache with 15-min TTL but log and compare every cached decision against a live permissions-service.check result.",
    "expected_signal": "If any stale-grant event exceeds the stated revocation SLA (likely <60s), the 15-min no-invalidation design is falsified; if the documented SLA is ≥15 minutes and zero stale-grant violations occur, KEEP becomes defensible."
  },
  "confidence": 0.85,
  "meta": {
    "review_id": "63218c5b…",
    "review_mode": "blind_first",
    "model": "xiaomi/mimo-v2.6-flash",
    "phases": 2,
    "usage": {
      "prompt_tokens": 2761,
      "completion_tokens": 1781,
      "total_tokens": 4542
    },
    "latency_ms": 33087
  }
}
```

Errors come back as an MCP tool error (`isError: true`) with `{"error": {"code", "message"}}`; codes: `CONFIG_ERROR`, `INVALID_INPUT`, `PROVIDER_HTTP_ERROR`, `PROVIDER_NETWORK_ERROR`, `TIMEOUT`, `MALFORMED_RESPONSE`, `BUDGET_EXCEEDED`, `OUTPUT_TRUNCATED` (output cut by `max_tokens`; raise `REVIEWER_MAX_TOKENS`), `BLINDNESS_LEAK`, `INTERNAL_ERROR` (unexpected exception).

Budget policy (near-hard cap):

- Before every call, `max_tokens = min(REVIEWER_MAX_TOKENS, remaining budget - prompt estimate)`. The estimate is deliberately pessimistic (~3 ASCII chars per token, every non-ASCII character = 1 token). If fewer than 256 tokens would remain, the call is not made.
- After every call, cumulative `usage.total_tokens` (provider-reported; estimated if the provider omits it) is compared with `MAX_REVIEW_TOKENS`; once reached, no further call is made.
- So completion tokens never exceed the clamped `max_tokens`; the cap can only be crossed by the call that crosses it, and only if the provider counts more prompt tokens than the pessimistic estimate.
- Before or inside Phase 1 (including its repair retry): `BUDGET_EXCEEDED` error. After Phase 1 with too little left for Phase 2: Phase 2 is skipped and the result is `INSUFFICIENT_EVIDENCE` with `confidence: 0` and `meta.budget_exhausted: true` (the Phase 1 position is still not returned).
- Malformed answers get at most **one** repair retry, then `MALFORMED_RESPONSE`. If the output was cut off (`finish_reason: "length"`) and is not valid JSON, there is no retry: `OUTPUT_TRUNCATED`.

### `should_review` (deterministic gate, no LLM)

`src/gate/decision-gate.ts`. Recommends a review for: architecture changes, DB schema changes and migrations, public API changes, key dependency replacements, large refactors, multi-module changes, performance/security decisions, complex debugging with several plausible hypotheses, high/critical risk. Not for formatting, renames, simple UI tweaks, obvious bug fixes, docs, small local changes (unless a structural signal overrides, e.g. renaming a public API field). Advisory: the main agent decides whether to call `review_decision`.

### `record_outcome`

Appends an outcome for a past review (see telemetry).

## When to call it

Suggested instruction for your agent (e.g. in `CLAUDE.md`, `AGENTS.md` or Cursor rules):

> Before committing to an expensive or hard-to-reverse decision (architecture, DB schema/migration, public API, key dependency, large/multi-module refactor, security/performance, debugging with several plausible causes), call `should_review`; if it recommends a review, call `review_decision` once with your proposal, then run the returned `falsification_probe` before implementing. Describe the problem in objective/constraints/context/evidence and put your plan only in proposed_solution. Do not call it for trivial changes.

## Telemetry and outcomes

Opt-in (`TELEMETRY_ENABLED=true`), local JSONL only (`./data/reviews.jsonl`), no external analytics. A review record contains only: `id`, `timestamp`, `review_mode`, `decision_type`, `risk_level`, `reviewer_model`, token usage, latency, `verdict`, `confidence`, `status`/`error_code`. No objective, context, constraints, evidence, proposal or reviewer text is stored (tested).

Mark what happened later, so you can eventually compute *cost per prevented bad decision*:

```bash
npm run outcome -- <review_id> --accepted true --rework false --useful true
```

or call the `record_outcome` MCP tool with `review_id`, `accepted_review`, `later_rework_required`, `review_was_useful`.

## Benchmark (v0.3: blind_first vs controls)

The benchmark tests one question: does `blind_first` give better review decisions than ordinary review **at comparable compute**? It is an evaluation harness only; none of the benchmark-only modes are exposed through the MCP tool.

```bash
npm run benchmark -- --label my-model --model vendor/model --base-url https://openrouter.ai/api/v1 \
  --runs 3 --concurrency 3 --timeout 240000 --out benchmark-results
```

All config is external (CLI flag overrides env): `--base-url` (`REVIEWER_BASE_URL`), `--model` (`REVIEWER_MODEL`), `--reasoning-effort` (`REVIEWER_REASONING_EFFORT`), `--reasoning-param`, `--temperature` (`REVIEWER_TEMPERATURE`), `--max-tokens` per call (`REVIEWER_MAX_TOKENS`), `--max-review-tokens` total cap per review (`MAX_REVIEW_TOKENS`), `--timeout` (`REVIEW_TIMEOUT`), `--runs` (`BENCHMARK_RUNS`, default 3), `--concurrency` (`BENCHMARK_CONCURRENCY`, default 2), `--retries` (default 2), `--seed`, `--modes`, `--only`, `--label`. The API key is read only from `REVIEWER_API_KEY` and is never written to results.

Output: `<out>/<label>/<timestamp>.json` (every run), `.md` (main report), `.decision_judge.md` (separate experiment), `.review-sheet.csv` + `.sheet-key.json` (human review). Every result records provider, base URL host, model, reasoning effort, token limits, temperature, timeout, timestamp, git SHA + dirty flag, case-set hash and prompt hashes. Runs of different models are independent; `npm run benchmark:compare -- <report.json> <report.json> ...` puts several labels side by side without declaring a winner.

### Modes

| mode | what the reviewer sees | calls |
|---|---|---|
| `proposal_first` | problem + proposal, single critique (public control mode) | 1 |
| `proposal_first_2pass` | benchmark-only compute-matched control: problem + proposal; pass 1 maps assumptions/alternatives/failure modes, pass 2 gives the verdict (same session) | 2 |
| `blind_first` | pass 1 without the proposal, pass 2 reveals it in the same session | 2 |
| `independent_only` | benchmark-only: pass 1 = the blind_first Phase 1 prompt (never the proposal); pass 2 is a **fresh session** that gets only the Phase-1 structured position (JSON) + the proposal and returns the verdict | 2 |
| `decision_judge` | separate experiment: problem + proposal, single pass, instructed to intervene only for a material problem and to value preserving a correct proposal equally | 1 |

Modes 2–4 use the same model, the same max tokens per call, the same total cap per review and the same reasoning effort and temperature (all from one config); actual tokens are reported. The order of modes is shuffled per (case, run) with a seeded PRNG.

**Why `independent_only` is designed this way.** The requirement is that the reviewer never receives `proposed_solution`, but a verdict on a proposal cannot be produced without someone looking at it. Options considered: (a) an LLM judge that sees the ground truth decides — rejected, it puts an LLM in the scoring loop; (b) only human scoring of required observations — kept as a supplementary measure (see human review), but it gives no verdict; (c) the chosen design: the independent position is produced blind, and a separate fresh call converts it into a verdict without the Phase-1 transcript. Compared with `blind_first`, this removes the in-session Reveal/Compare trajectory (self-anchoring on its own reasoning, or being pulled back toward the proposal on reveal). Known confound: the comparer does not see the problem statement (objective/context), only the position, so a difference vs `blind_first` can also come from that missing context. The independent reviewer itself never sees the proposal (tested with a sentinel); the comparer never sees the blind fields (tested).

### Cases

25 cases, one JSON file per case in `benchmark/cases/` (structure ready for 30–50; add files, the loader validates them). 13 flawed (materially or fundamentally), 12 correct. 12 are adapted from public material (postmortems, incident writeups, engineering blogs, an SEC order), 13 are synthetic (11 migrated from v0.2 plus 2 new). The source URL is kept in metadata only.

```json
{ "id": "...", "title": "...", "category": "...",
  "source": { "type": "real_pr|reverted_pr|postmortem|issue|incident|synthetic", "url": "...", "note": "..." },
  "input": { "objective": "...", "constraints": ["..."], "context": "...", "environment": "...", "evidence": "...",
             "proposed_solution": "...", "decision_type": "...", "risk_level": "..." },
  "ground_truth": { "proposal_status": "correct|materially_flawed|fundamentally_flawed|insufficient_information",
                    "acceptable_verdicts": ["REPLACE", "MODIFY"], "material_issue": "...",
                    "required_observations": ["..."], "notes": "..." },
  "diagnostics": { "hidden_flaw_keywords": ["regex", "..."] } }
```

- The reviewer request is built by an explicit pick of `case.input` fields only. A test runs every case through every mode with sentinels planted in `source`, `ground_truth` and `diagnostics` and checks that neither the sentinel nor any ground-truth string reaches any provider request.
- `acceptable_verdicts[0]` is the expected primary verdict. Correct proposals accept **KEEP only**; flawed proposals never accept KEEP.
- Every case passes the blindness overlap check below the warn threshold (tested).
- Real-sourced cases are compact, self-contained adaptations; no private code is copied. Their known outcome (what actually happened) may still be in the reviewer model's training data, which is a contamination risk.

### Metrics (mechanical, no LLM judge)

- **Decision accuracy**: verdict ∈ `acceptable_verdicts`. Shown over successful runs and **strict** (failed runs count as wrong).
- **Correct KEEP**: KEEP rate on correct proposals. **Defect detection**: MODIFY or REPLACE on flawed proposals. **Exact verdict**: verdict = primary expected verdict.
- **False intervention**: MODIFY on a correct proposal. **Severe false intervention**: REPLACE on a correct proposal. **Insufficient-evidence rate**.
- Tokens and latency: mean and median; relative token cost vs `proposal_first`; tokens of failed attempts are counted in the cost section.
- Keyword hit-rate: **diagnostic only** (narrow regexes), not a quality measure.
- Rates have 95% Wilson intervals. Mode differences use a paired cluster bootstrap over cases (5000 resamples, seeded).
- Failures never shrink denominators silently: expected / successful / failed / failure reasons and retries are reported per mode. Transient errors (timeout, network, HTTP 429/5xx) are retried up to `--retries` times with backoff and logged.

### Pre-registered decision rules

Written and committed before the v0.3.0 runs (`benchmark/thresholds.ts`). Δ = metric(A) − metric(B), positive = A better, with the 95% paired bootstrap CI [lo, hi]:

| label | rule |
|---|---|
| clear signal | Δ ≥ +0.10 and lo > 0 |
| weak signal | Δ ≥ +0.05 and lo > −0.05 (and not clear) |
| no observed advantage | Δ ≤ 0 |
| inconclusive | anything else |

- Q1 `blind_first` vs `proposal_first`, Q2 `blind_first` vs `proposal_first_2pass` (**main test**), Q3 `independent_only` vs `blind_first`: primary metric = strict decision accuracy.
- Q4 `decision_judge` vs `proposal_first` (critic bias): primary metric = reduction in intervention (MODIFY/REPLACE) on correct proposals; the label gets the suffix "(with defect-detection loss)" if defect detection drops by more than 0.10.

### Human review (no LLM judge)

Each run exports `<ts>.review-sheet.csv`: one row per (flawed-case result, required observation), with the reviewer's risks / alternative / probe and an empty `hit` column (yes/no). The mode is hidden behind an item id (key in `<ts>.sheet-key.json`) so the human scorer is blind to the mode. After filling it in: `npm run benchmark:ingest -- <ts>.review-sheet.csv <ts>.sheet-key.json` prints required-observation coverage per mode.

### Honest limits of the blindness protection

- The overlap check is lexical. A semantic paraphrase of the plan in `context` cannot be reliably detected by string checks.
- Blind isolation is guaranteed only against an honest caller. A caller that writes its plan into the blind fields defeats it.
- `decision_type` and `risk_level` are visible to Phase 1 by design.

### Results

See [`benchmark-results/sample/`](benchmark-results/sample/) (per-label folders; v1 and v0 runs of v0.2 kept for history).

## Development

```bash
npm run lint       # eslint (typescript-eslint flat config)
npm run typecheck  # tsc --noEmit, strict
npm run build
npm test           # vitest with a fake provider; also spawns the built server over stdio
```

Layout:

```
src/server.ts                 stdio entry point
src/create-server.ts          MCP tools wiring
src/reviewer/reviewer.ts      review orchestration, timeout, blindness check, telemetry
src/reviewer/blind-first.ts   phase 1 (blind) + phase 2 (reveal) in one session
src/reviewer/blindness.ts     deterministic leak check (5-gram containment)
src/reviewer/proposal-first-2pass.ts  benchmark-only compute-matched control
src/reviewer/benchmark-modes.ts      benchmark-only independent_only + decision_judge
src/reviewer/prompt-fingerprint.ts   prompt hashes (frozen by tests/prompt-freeze.test.ts)
src/reviewer/proposal-first.ts control mode
src/reviewer/session.ts       per-review state, token budget, JSON validation + 1 repair retry
src/reviewer/prompts.ts       prompt builders (phase 1 builder only accepts BlindInput)
src/reviewer/json.ts          JSON extraction / normalisation
src/providers/provider.ts     provider interface (no tools field by design)
src/providers/openai-compatible.ts  the only adapter in the MVP
src/gate/decision-gate.ts     deterministic gate
src/schemas/review.ts         Zod schemas and types
src/telemetry/telemetry.ts    opt-in JSONL telemetry
src/cli/outcome.ts            outcome marking CLI
benchmark/                    cli, runner, metrics, stats, thresholds, report, compare, human review
benchmark/cases/              benchmark cases (one file per case)
```

New providers (Anthropic, Gemini, native OpenRouter/xAI, local runtimes) implement `ReviewerProvider` in `src/providers/`; nothing else changes.

## Limitations

- Research MVP: the hypothesis is **not** established (see benchmark results). Synthetic cases were written by the tool's author; real-sourced cases may be in model training data. The keyword metric is diagnostic only.
- The reviewer only knows what the main agent puts into `context`/`evidence`; it has no repo access or tools. Garbage in, garbage out.
- Blind-first costs roughly 2-2.5x the tokens of a single-pass critique (two calls; Phase 2 resends Phase 1).
- The blindness check is lexical: it detects copied or near-copied plans; a semantic paraphrase hidden in `context` cannot be reliably detected by string checks. Blind isolation is not guaranteed against a dishonest caller.
- Token budget is a near-hard cap (see budget policy), not an exact one.
- Only an OpenAI-compatible adapter is implemented.

## Intentionally not implemented

Web UI, database server, Docker, auth, cloud backend, vector DB, RAG, memory, multiple reviewers, teams, voting, debate rounds, orchestration frameworks, reviewer tools.

## License

MIT
