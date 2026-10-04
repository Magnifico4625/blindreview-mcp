import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkReport } from "./runner.js";
import { diff, pct } from "./report.js";

/**
 * Side-by-side view of several labels (e.g. one per model). Each argument is a label directory
 * (latest .json inside is used) or a report .json. No winner is declared.
 * Usage: npm run benchmark:compare -- benchmark-results/sample/<labelA> benchmark-results/sample/<labelB>
 */
async function load(p: string): Promise<BenchmarkReport> {
  let file = p;
  if (!p.endsWith(".json")) {
    const files = (await readdir(p)).filter((f) => f.endsWith(".json") && !f.includes("sheet-key")).sort();
    if (!files.length) throw new Error(`No report .json in ${p}`);
    file = path.join(p, files[files.length - 1] as string);
  }
  return JSON.parse(await readFile(file, "utf8")) as BenchmarkReport;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log("Usage: npm run benchmark:compare -- <labelDir|report.json> [...]");
    process.exit(1);
  }
  const reports = await Promise.all(args.map(load));
  const L = ["# Side-by-side comparison (no winner declared)", "", "| label | model | case set | runs | git |", "|---|---|---|---|---|"];
  for (const r of reports) L.push(`| ${r.label} | ${r.model} | ${r.case_set_hash} (${r.case_count}) | ${r.runs} | ${r.git.sha?.slice(0, 10) ?? "?"}${r.git.dirty ? " dirty" : ""} |`);
  L.push("", "| label | mode | decision acc. (strict) | correct KEEP | defect detection | false intervention | severe | avg tokens | failed |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of reports) {
    for (const m of r.metrics) {
      L.push(`| ${r.label} | ${m.mode} | ${pct(m.decision_accuracy_strict)} | ${pct(m.keep_accuracy_correct)} | ${pct(m.defect_detection)} | ${pct(m.false_intervention)} | ${pct(m.severe_false_intervention)} | ${m.tokens.mean ?? "–"} | ${m.failed}/${m.expected} |`);
    }
  }
  L.push("", "| label | question | Δ (95% CI) | label |", "|---|---|---|---|");
  for (const r of reports) for (const c of r.comparisons) L.push(`| ${r.label} | ${c.question} ${c.a} vs ${c.b} | ${diff(c.primary)} | ${c.label} |`);
  console.log(`${L.join("\n")}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
