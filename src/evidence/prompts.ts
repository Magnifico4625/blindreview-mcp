import type { ChatMessage } from "../providers/provider.js";

/**
 * evidence_gate prompt and tool definitions (v0.4.0). Frozen by hash in tests/prompt-freeze.test.ts
 * (template rendered with placeholders, see src/reviewer/prompt-fingerprint.ts).
 */

export interface RepoTaskView {
  objective: string;
  constraints: string[];
  context: string;
  environment?: string;
  /** Repo-relative file list of the snapshot. */
  files: string[];
  /** Allowlisted test files for run_test. */
  tests: string[];
  /** Plan text + unified diff (already applied in the snapshot). */
  proposed_solution: string;
  decision_type: string;
  risk_level: string;
}

/** Text both evidence_gate and the decision_judge baseline get (decision_judge: as the `context`). */
export function repoContextBlock(view: Pick<RepoTaskView, "context" | "files" | "tests">): string {
  return `${view.context}

Repository snapshot (the proposed patch is already applied):
${view.files.map((f) => `- ${f}`).join("\n")}
Existing test files: ${view.tests.join(", ") || "(none)"}`;
}

export function buildEvidenceGateMessages(view: RepoTaskView, maxToolCalls: number): ChatMessage[] {
  const constraints = view.constraints.length ? view.constraints.map((c) => `- ${c}`).join("\n") : "- (none)";
  return [
    {
      role: "system",
      content: `You are an independent decision judge for a change proposed by an AI coding agent. You have read-only access to a small snapshot of the repository with the proposed patch ALREADY APPLIED.
Preserving a correct proposal is exactly as valuable as stopping a flawed one. Do not intervene because another valid design exists, because of style, naming or missing nice-to-haves, or because of risks the constraints explicitly rule out.

Procedure:
1. Read the task and the proposal. Decide whether you suspect a MATERIAL defect: the change is incorrect, breaks existing behaviour or callers, violates a stated constraint, loses data, or is unsafe.
2. No material defect -> answer decision "KEEP".
3. If you suspect one, formulate ONE falsifiable claim and try to verify it with the tools:
   - run_test: run an existing test file (allowlist only);
   - typecheck: run the TypeScript checker on the snapshot;
   - search / find_symbol: find concrete code locations (file:line) elsewhere in the repository that contradict the proposal;
   - read_file / inspect_config: read code and package/config/schema files.
4. Report the claim honestly with result:
   - "confirmed" ONLY if a tool output from THIS session shows it: a failing test, a typecheck error, or a concrete search hit (file:line) outside the lines the patch added. Cite the tool output ids (e.g. "T2") and the file:line locations in evidence_refs.
   - "not_confirmed" if you checked and the evidence does not support the claim;
   - "unable_to_verify" if the tools cannot show it (e.g. performance, architecture, security properties).
The harness checks your citations against the tool log. A "confirmed" claim without a matching artifact is downgraded to "not_confirmed", and MODIFY/REPLACE are only accepted with a validated confirmed claim; otherwise the final verdict becomes WARNING. Use WARNING for a real but unverifiable concern, KEEP if the concern is minor.
You may make at most ${maxToolCalls} tool calls. Never ask to edit files or run other commands.

Final answer: ONLY a JSON object, no prose, no markdown fences:
{
  "decision": "KEEP" | "CLAIM",
  "summary": "one or two sentences",
  "claim": null | {
    "claim": "the specific defect, falsifiable",
    "severity": "low" | "medium" | "high" | "critical",
    "evidence_needed": "what mechanical evidence would prove it",
    "verification": "what you ran and what it showed",
    "evidence_refs": ["T2", "src/file.js:12"],
    "result": "confirmed" | "not_confirmed" | "unable_to_verify",
    "verdict": "KEEP" | "WARNING" | "MODIFY" | "REPLACE"
  }
}`,
    },
    {
      role: "user",
      content: `## Task
<objective>
${view.objective}
</objective>

<constraints>
${constraints}
</constraints>

<context>
${repoContextBlock(view)}
</context>
${view.environment ? `\n<environment>\n${view.environment}\n</environment>\n` : ""}
Decision type: ${view.decision_type} · Risk level: ${view.risk_level}

## Proposed change
<proposed_solution>
${view.proposed_solution}
</proposed_solution>

Judge the proposal. Use tools only if you suspect a material defect. Then return the final JSON.`,
    },
  ];
}

export const BUDGET_EXHAUSTED_MESSAGE = "Tool budget exhausted. No more tool calls are possible. Return the final JSON answer now, citing only tool outputs you already have.";

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const EVIDENCE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search",
      description: "Regex search over all repository files (case-insensitive by default). Returns file:line: text hits.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression" },
          path_prefix: { type: "string", description: "Optional directory or file to restrict the search" },
          case_sensitive: { type: "boolean" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_symbol",
      description: "Find definitions and references of an identifier (whole word) across the repository.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a repository file with line numbers (size-capped; use start_line to page).",
      parameters: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_config",
      description: "Without path: package.json, list of config/schema files and the run_test allowlist. With path: read a package/config/schema file (.json, .sql, .yaml, .toml).",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "run_test",
      description: "Run ONE existing test file from the allowlist with node --test. Returns pass/fail counts and failure details.",
      parameters: { type: "object", properties: { test_file: { type: "string", description: "e.g. test/foo.test.js" } }, required: ["test_file"] },
    },
  },
  {
    type: "function",
    function: {
      name: "typecheck",
      description: "Run tsc --noEmit on the snapshot's tsconfig.json. Returns compiler errors as file(line,col): error TSxxxx.",
      parameters: { type: "object", properties: {} },
    },
  },
];
