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

Hard invariants: exactly 1 main agent + 1 reviewer; the reviewer has no tools, cannot delegate or call `review_decision` (a re-entrancy guard rejects nested calls); no recursive agents.

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

Copy `.env.example` to `.env` in the repo root (`copy .env.example .env` on Windows cmd, `cp .env.example .env` elsewhere). The server loads `<repo>/.env` itself (no dependency, independent of the working directory the MCP client uses); variables passed by the MCP client's `env` block take precedence. Set `BLINDREVIEW_ENV_FILE` to use a different file.

| Variable | Default | Meaning |
|---|---|---|
| `REVIEWER_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible `/chat/completions` base URL |
| `REVIEWER_API_KEY` | – | API key (omit for local servers) |
| `REVIEWER_MODEL` | `gpt-5-mini` | Reviewer model id |
| `REVIEWER_REASONING_EFFORT` | – | `low` / `medium` / `high`; dropped automatically if the API rejects it |
| `REVIEWER_REASONING_PARAM` | auto | `reasoning_effort` (OpenAI/xAI) or `reasoning_object` (OpenRouter `reasoning: {effort}`); auto-detected from the URL |
| `REVIEWER_MAX_TOKENS` | `4000` | Max completion tokens per call |
| `MAX_REVIEW_TOKENS` | `20000` | Hard cap on cumulative tokens (prompt + completion) across all phases |
| `MAX_TOOL_CALLS` | `0` | The reviewer has no tools; tool calls are never executed and answers with more than this many are rejected |
| `REVIEW_TIMEOUT` | `120000` | Timeout for the whole review in ms (AbortController) |
| `TELEMETRY_ENABLED` | `false` | Opt-in local JSONL telemetry |
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

Output example (real blind_first output for the `authz-cache-ttl` case, lists truncated with "…"):

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

Errors come back as an MCP tool error (`isError: true`) with `{"error": {"code", "message"}}`; codes: `CONFIG_ERROR`, `INVALID_INPUT`, `PROVIDER_HTTP_ERROR`, `PROVIDER_NETWORK_ERROR`, `TIMEOUT`, `MALFORMED_RESPONSE`, `BUDGET_EXCEEDED`, `RECURSION_BLOCKED`.

Budget policy: `max_tokens` of each call is clamped to the remaining review budget. If the budget is exhausted before Phase 1 can run, the call fails with `BUDGET_EXCEEDED`. If Phase 1 leaves too little for Phase 2, Phase 2 is skipped and the result is `INSUFFICIENT_EVIDENCE` with `confidence: 0` and `meta.budget_exhausted: true` (the Phase 1 position is still not returned). Malformed answers get at most **one** repair retry, then `MALFORMED_RESPONSE`.

### `should_review` (deterministic gate, no LLM)

`src/gate/decision-gate.ts`. Recommends a review for: architecture changes, DB schema changes and migrations, public API changes, key dependency replacements, large refactors, multi-module changes, performance/security decisions, complex debugging with several plausible hypotheses, high/critical risk. Not for formatting, renames, simple UI tweaks, obvious bug fixes, docs, small local changes (unless a structural signal overrides, e.g. renaming a public API field). Advisory: the main agent decides whether to call `review_decision`.

### `record_outcome`

Appends an outcome for a past review (see telemetry).

## When to call it

Suggested instruction for your agent (e.g. in `CLAUDE.md`, `AGENTS.md` or Cursor rules):

> Before committing to an expensive or hard-to-reverse decision (architecture, DB schema/migration, public API, key dependency, large/multi-module refactor, security/performance, debugging with several plausible causes), call `should_review`; if it recommends a review, call `review_decision` once with your proposal, then run the returned `falsification_probe` before implementing. Do not call it for trivial changes.

## Telemetry and outcomes

Opt-in (`TELEMETRY_ENABLED=true`), local JSONL only (`./data/reviews.jsonl`), no external analytics. A review record contains only: `id`, `timestamp`, `review_mode`, `decision_type`, `risk_level`, `reviewer_model`, token usage, latency, `verdict`, `confidence`, `status`/`error_code`. No objective, context, constraints, evidence, proposal or reviewer text is stored (tested).

Mark what happened later, so you can eventually compute *cost per prevented bad decision*:

```bash
npm run outcome -- <review_id> --accepted true --rework false --useful true
```

or call the `record_outcome` MCP tool with `review_id`, `accepted_review`, `later_rework_required`, `review_was_useful`.

## Benchmark (A/B: blind_first vs proposal_first)

```bash
npm run benchmark -- ./examples/cases
```

Runs every case in `proposal_first` and `blind_first` with the same model and the same budget, sequentially, and writes `benchmark-results/<timestamp>.json` (side by side) and `<timestamp>.md` (summary table). Options: `--only <id,id>`, `--modes proposal_first,blind_first`, `--out <dir>`.

`benchmark/evaluator.ts` computes **mechanical** statistics only: verdict, confidence, tokens, latency, and whether the returned text mentions the case's `hidden_flaw_keywords` (a crude heuristic). There is no LLM judge and no winner is declared; read the outputs yourself.

Cases live in `examples/cases/*.json`. Each has `input` (what the reviewer sees) plus human-only fields `hidden_flaw`, `hidden_flaw_keywords`, `notes`, `has_hidden_flaw` that are never sent to the reviewer. Included: per-user authz cache with TTL invalidation, 900M-row column retype under lock during a rolling deploy, public API `id` number→string change, check-then-act race "fixed" with an in-process mutex across 8 replicas, big-bang multi-service billing rewrite, RabbitMQ→Redis Pub/Sub swap, and one sound control case (concurrent index) to measure false alarms.

A committed sample run is in [`benchmark-results/sample/`](benchmark-results/sample/). First run (2026-10-04, `xiaomi/mimo-v2.6-flash` via OpenRouter, reasoning effort unset, 20k token budget, one run per mode, ~43k tokens total):

| mode | flawed cases flagged (MODIFY/REPLACE) | REPLACE on flawed | sound control kept | avg tokens / review | avg latency |
|---|---|---|---|---|---|
| proposal_first | 6/6 | 3/6 | 0/1 (MODIFY) | ~1.7k | ~29 s |
| blind_first | 6/6 | 4/6 | 1/1 (KEEP) | ~4.4k | ~34 s |

Reading it honestly: n=7, single run, one lightweight model. Both modes caught every planted flaw (keyword heuristic hit rates 0.92 vs 0.88); blind_first was harsher on flawed proposals and did not raise a false alarm on the sound control, at ~2.6x the tokens. This is a smoke test, not evidence for the hypothesis; harder cases and repeated runs are needed.

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
src/reviewer/reviewer.ts      review orchestration, timeout, re-entrancy guard, telemetry
src/reviewer/blind-first.ts   phase 1 (blind) + phase 2 (reveal) in one session
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
benchmark/                    runner, evaluator, case loader
examples/cases/               benchmark cases
```

New providers (Anthropic, Gemini, native OpenRouter/xAI, local runtimes) implement `ReviewerProvider` in `src/providers/`; nothing else changes.

## Limitations

- Research MVP: the hypothesis is **not** proven. Small case set, keyword heuristics, single runs, no statistics.
- The reviewer only knows what the main agent puts into `context`/`evidence`; it has no repo access or tools. Garbage in, garbage out.
- Blind-first costs roughly 2-3x the tokens of plain critique (two calls, Phase 2 resends Phase 1).
- Token budget pre-checks use a ~4 chars/token estimate; actual provider usage can overshoot slightly on the last call.
- The re-entrancy guard is per process (AsyncLocalStorage). It blocks recursion from within a review; it cannot see a different process calling a different server instance.
- Only an OpenAI-compatible adapter is implemented.

## Intentionally not implemented

Web UI, database server, Docker, auth, cloud backend, vector DB, RAG, memory, multiple reviewers, teams, voting, debate rounds, orchestration frameworks, reviewer tools.

## License

MIT
