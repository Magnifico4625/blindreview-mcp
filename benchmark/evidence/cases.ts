import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { changedLinesFromDiff, type ChangedLines } from "../../src/evidence/gate.js";
import { repoContextBlock, type RepoTaskView } from "../../src/evidence/prompts.js";
import { DecisionTypeSchema, RiskLevelSchema, VerdictSchema, type ReviewInput } from "../../src/schemas/review.js";
import { PROPOSAL_STATUSES, SOURCE_TYPES } from "../cases.js";

/**
 * v0.4.0 repo-snapshot cases: benchmark/repo-cases/<nn-id>/{case.json, repo/}.
 * repo/ is the repository AFTER the proposed patch; the patch itself is part of input.proposed_solution.
 * Only `input` (+ the snapshot) reaches a model. `ground_truth` lives in case.json, OUTSIDE repo/,
 * so the sandboxed tools cannot read it.
 */
export const DEFECT_KINDS = ["test", "typecheck", "search", "untestable", "none"] as const;
export type DefectKind = (typeof DEFECT_KINDS)[number];

export const RepoCaseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.string().min(1),
    source: z.object({ type: z.enum(SOURCE_TYPES), url: z.string().url().optional(), note: z.string() }),
    input: z
      .object({
        objective: z.string().min(1),
        constraints: z.array(z.string()),
        context: z.string(),
        environment: z.string().optional(),
        proposed_solution: z.string().min(1),
        decision_type: DecisionTypeSchema,
        risk_level: RiskLevelSchema,
      })
      .strict(),
    ground_truth: z
      .object({
        proposal_status: z.enum(PROPOSAL_STATUSES),
        acceptable_verdicts: z.array(VerdictSchema).min(1),
        defect_kind: z.enum(DEFECT_KINDS),
        mechanically_confirmable: z.boolean(),
        material_issue: z.string(),
        required_observations: z.array(z.string()),
        notes: z.string().default(""),
      })
      .strict(),
  })
  .strict();
export type RepoCase = z.infer<typeof RepoCaseSchema> & { dir: string; repoDir: string };

export const DEFAULT_REPO_CASES_DIR = path.join("benchmark", "repo-cases");

export const isRepoFlawed = (c: RepoCase) => c.ground_truth.proposal_status === "materially_flawed" || c.ground_truth.proposal_status === "fundamentally_flawed";
export const isTestableDefect = (c: RepoCase) => isRepoFlawed(c) && c.ground_truth.mechanically_confirmable;
export const isUntestableDefect = (c: RepoCase) => isRepoFlawed(c) && !c.ground_truth.mechanically_confirmable;
export const isRepoCorrect = (c: RepoCase) => c.ground_truth.proposal_status === "correct";

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

export async function loadRepoCases(dir: string): Promise<{ cases: RepoCase[]; hash: string }> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const h = createHash("sha256");
  const cases: RepoCase[] = [];
  const ids = new Set<string>();
  for (const name of entries) {
    const caseDir = path.join(dir, name);
    const text = (await readFile(path.join(caseDir, "case.json"), "utf8")).replace(/\r\n/g, "\n");
    const parsed = RepoCaseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`Invalid repo case ${name}: ${parsed.error.message}`);
    const c = parsed.data;
    if (ids.has(c.id)) throw new Error(`Duplicate case id ${c.id}`);
    ids.add(c.id);
    const flawed = c.ground_truth.proposal_status === "materially_flawed" || c.ground_truth.proposal_status === "fundamentally_flawed";
    if (flawed && c.ground_truth.acceptable_verdicts.includes("KEEP")) throw new Error(`Invalid repo case ${name}: a flawed proposal cannot accept KEEP`);
    if (flawed === (c.ground_truth.defect_kind === "none")) throw new Error(`Invalid repo case ${name}: defect_kind inconsistent with proposal_status`);
    if (c.ground_truth.mechanically_confirmable !== ["test", "typecheck", "search"].includes(c.ground_truth.defect_kind)) {
      throw new Error(`Invalid repo case ${name}: mechanically_confirmable inconsistent with defect_kind`);
    }
    h.update(name).update("\0").update(text).update("\0");
    const repoDir = path.join(caseDir, "repo");
    for (const f of await walk(repoDir)) h.update(f).update("\0").update((await readFile(path.join(repoDir, f), "utf8")).replace(/\r\n/g, "\n")).update("\0");
    cases.push({ ...c, dir: caseDir, repoDir });
  }
  return { cases, hash: h.digest("hex").slice(0, 16) };
}

/** The unified diff embedded in proposed_solution (input-only data). */
export function extractDiff(proposed: string): string {
  const m = /```diff\n([\s\S]*?)```/.exec(proposed);
  return m?.[1] ?? "";
}

export function changedLinesOf(c: RepoCase): ChangedLines {
  return changedLinesFromDiff(extractDiff(c.input.proposed_solution));
}

/** The ONLY bridge from a repo case to the evidence_gate prompt: explicit picking from case.input + snapshot listing. */
export function toRepoView(c: RepoCase, files: string[], tests: string[]): RepoTaskView {
  const i = c.input;
  return {
    objective: i.objective,
    constraints: [...i.constraints],
    context: i.context,
    ...(i.environment !== undefined ? { environment: i.environment } : {}),
    files,
    tests,
    proposed_solution: i.proposed_solution,
    decision_type: i.decision_type,
    risk_level: i.risk_level,
  };
}

/** Same information for the text-only baselines (decision_judge / proposal_first): no tools, same text. */
export function toBaselineInput(c: RepoCase, files: string[], tests: string[]): ReviewInput {
  const i = c.input;
  const input: ReviewInput = {
    objective: i.objective,
    constraints: [...i.constraints],
    context: repoContextBlock({ context: i.context, files, tests }),
    proposed_solution: i.proposed_solution,
    decision_type: i.decision_type,
    risk_level: i.risk_level,
  };
  if (i.environment !== undefined) input.environment = i.environment;
  return input;
}
