import { readFile, writeFile } from "node:fs/promises";
import { ingestSheet, type SheetKey } from "./human-review.js";
import { pct } from "./report.js";

/** Usage: npm run benchmark:ingest -- <filled-sheet.csv> <sheet-key.json> [out.md] */
async function main(): Promise<void> {
  const [sheet, keyFile, out] = process.argv.slice(2);
  if (!sheet || !keyFile) {
    console.log("Usage: npm run benchmark:ingest -- <filled-sheet.csv> <sheet-key.json> [out.md]");
    process.exit(1);
  }
  const key = JSON.parse(await readFile(keyFile, "utf8")) as SheetKey;
  const cov = ingestSheet(await readFile(sheet, "utf8"), key);
  const md = [
    `# Human review of required observations — ${key.label}`,
    "",
    "Filled manually (no LLM judge). Rows were blinded to mode; unfilled rows are excluded from hit rates and count as not-all-hit.",
    "",
    "| mode | rows | filled | observation hit rate | results with all observations hit |",
    "|---|---|---|---|---|",
    ...cov.map((c) => `| ${c.mode} | ${c.rows} | ${c.filled} | ${pct(c.hit)} | ${pct(c.all_hit)} |`),
    "",
  ].join("\n");
  if (out) await writeFile(out, md, "utf8");
  console.log(md);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
