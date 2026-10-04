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

## Benchmark (blind_first vs controls)

```bash
npm run benchmark -- ./examples/cases --runs 3 --seed 42
```

Options: `--runs N` (default 3), `--seed N` (mode order shuffle), `--modes`, `--only <id,id>`, `--concurrency N`, `--out <dir>`, `--price-in/--price-out` (USD per 1M tokens, for a cost estimate). Output: `benchmark-results/<timestamp>.json` (every run, side by side) and `<timestamp>.md` (summary).

Modes, all with the same model, config and token budget:

| mode | what the reviewer sees | calls |
|---|---|---|
| `proposal_first` | problem + proposal, single critique (public control mode) | 1 |
| `proposal_first_2pass` | **benchmark-only** compute-matched control: problem + proposal; pass 1 maps assumptions/alternatives/failure modes, pass 2 gives the verdict | 2 |
| `blind_first` | pass 1 without the proposal, pass 2 with it revealed | 2 |

`proposal_first_2pass` separates "blindness" from "the reviewer simply thought longer". It is not exposed through the MCP tool. The mode order is shuffled per case and run with a seeded PRNG.

Cases (`examples/cases/*.json`): 6 with a planted fundamental flaw (per-user authz cache with TTL-only expiry; integer→numeric column retype + rename on a 900M-row table during rolling deploys; public API `id` number→string; check-then-act race "fixed" with an in-process mutex on a multi-replica service; big-bang multi-service billing rewrite; RabbitMQ→Redis Pub/Sub for jobs that include payment webhooks) and 5 sound controls (concurrent index; additive `id_str` field; transactional outbox; per-request DataLoader; strangler-style billing refactor with golden tests and shadow run). Flawed proposals are written to sound convincing, and the facts needed to find the flaw are present but the consequence is not spelled out. Each case has `expected_verdict` and `acceptable_verdicts`; `hidden_flaw`, `notes` and keywords are human-only and never sent to the reviewer (tested).

`benchmark/evaluator.ts` computes mechanical statistics only, without an LLM judge:

- **exact**: verdict equals `expected_verdict`. **acceptable**: verdict is in `acceptable_verdicts` (flawed cases: MODIFY or REPLACE; sound cases: KEEP or MODIFY).
- Severity KEEP < MODIFY < REPLACE. **under**: less severe than every acceptable verdict (KEEP on a flawed case). **over**: more severe (REPLACE on a sound case). `INSUFFICIENT_EVIDENCE` counts as an abstention.
- **false alarm**: REPLACE on a sound control.
- Rates are reported with 95% Wilson intervals; tokens and latency as mean ± sd.
- Keyword ratio: a *weak* heuristic (narrow regex groups per flawed case). It only shows the topic was mentioned.

### Results: v1 run (2026-10-04)

`xiaomi/mimo-v2.6-flash` via OpenRouter, 11 cases × 3 modes × 3 runs = 99 reviews, seed 42, budget 20k tokens per review (4k per call), timeout 120 s, reasoning effort and temperature at provider defaults. Full data: [`benchmark-results/sample/2026-10-04T08-53-26-127Z.md`](benchmark-results/sample/2026-10-04T08-53-26-127Z.md) / `.json`. Cost: ≈ $0.069 estimated from token counts; OpenRouter-reported spend for the whole fix pass (this run plus a 2-case smoke run) was $0.073.

| mode | errors | flawed: exact | flawed: acceptable | flawed: under / over | sound: exact KEEP | sound: acceptable | sound: false alarm (REPLACE) | tokens/review | latency, s |
|---|---|---|---|---|---|---|---|---|---|
| proposal_first | 2/33 | 11/17 (65%, CI 41–83) | 17/17 (CI 82–100) | 0 / 0 | 1/14 (7%, CI 1–32) | 14/14 (CI 79–100) | 0/14 (CI 0–22) | 1875 ± 464 | 35 ± 14 |
| proposal_first_2pass | 1/33 | 12/17 (71%, CI 47–87) | 17/17 (CI 82–100) | 0 / 0 | 0/15 (0%, CI 0–20) | 15/15 (CI 80–100) | 0/15 (CI 0–20) | 4360 ± 651 | 38 ± 15 |
| blind_first | 1/33 | 12/17 (71%, CI 47–87) | 17/17 (CI 82–100) | 0 / 0 | 2/15 (13%, CI 4–38) | 15/15 (CI 80–100) | 0/15 (CI 0–20) | 4524 ± 1031 | 36 ± 18 |

Errors: 3 × `TIMEOUT` (proposal_first ×2, blind_first ×1; run with 6 parallel workers) and 1 × `MALFORMED_RESPONSE` (proposal_first_2pass).

Observations, stated neutrally:

- On this run the three modes are **not distinguishable**: every mode gave an acceptable verdict on every successful flawed run, and no mode returned REPLACE on a sound control. The differences in exact-match rates are 1–2 runs and fall well inside the confidence intervals.
- The sound controls are almost always answered with MODIFY in every mode (exact KEEP 0–13%). So with this model the KEEP/MODIFY boundary carries little signal, and "acceptable" on controls is not a demanding metric.
- Exact-match misses on flawed cases are mostly MODIFY where REPLACE was expected (e.g. `api-id-type-change`: MODIFY in 9/9 runs across all modes). blind_first gave MODIFY instead of REPLACE on `coupon-double-redeem` in 1/3 runs, where both controls gave REPLACE 3/3.
- blind_first costs about 2.4× the tokens of proposal_first and about the same as the compute-matched `proposal_first_2pass`.
- Limits of this evidence: the cases were written by the tool's author, there is a single lightweight model, n is small (17 flawed and 15 sound runs per mode), and there are ceiling effects on the flawed cases. A real test needs harder cases written by someone else, more models and more runs.

The superseded v0 smoke run is in [`benchmark-results/sample/v0/`](benchmark-results/sample/v0/).

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
benchmark/                    cli (entry), runner, evaluator, stats, case loader
examples/cases/               benchmark cases
```

New providers (Anthropic, Gemini, native OpenRouter/xAI, local runtimes) implement `ReviewerProvider` in `src/providers/`; nothing else changes.

## Limitations

- Research MVP: the hypothesis is **not** established. The cases were written by the same author as the tool, there is one reviewer model, and n is small (11 cases × 3 runs). The keyword metric is weak.
- The reviewer only knows what the main agent puts into `context`/`evidence`; it has no repo access or tools. Garbage in, garbage out.
- Blind-first costs roughly 2-2.5x the tokens of a single-pass critique (two calls; Phase 2 resends Phase 1).
- The blindness check is lexical: it detects copied or near-copied plans, not a reworded plan hidden in `context`.
- Token budget is a near-hard cap (see budget policy), not an exact one.
- Only an OpenAI-compatible adapter is implemented.

## Intentionally not implemented

Web UI, database server, Docker, auth, cloud backend, vector DB, RAG, memory, multiple reviewers, teams, voting, debate rounds, orchestration frameworks, reviewer tools.

## License

MIT
