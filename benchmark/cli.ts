import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { buildProvider } from "../src/create-server.js";
import { ALL_MODES, type AnyMode } from "../src/schemas/review.js";
import { loadCases } from "./cases.js";
import { DEFAULT_MODES, fileTimestamp, runBenchmark, safeHost, toMarkdown } from "./runner.js";

const USAGE = `Usage: npm run benchmark -- [casesDir] [options]
  --runs N            runs per case and mode (default 3)
  --seed N            seed for the per-case mode order shuffle (default 42)
  --modes a,b,c       default ${DEFAULT_MODES.join(",")}
  --only id,id        run only these case ids
  --concurrency N     parallel (case, run) units (default 1)
  --out DIR           output directory (default benchmark-results)
  --price-in USD      optional price per 1M prompt tokens, for a cost estimate
  --price-out USD     optional price per 1M completion tokens`;

function int(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: "benchmark-results" },
      modes: { type: "string", default: DEFAULT_MODES.join(",") },
      only: { type: "string" },
      runs: { type: "string" },
      seed: { type: "string" },
      concurrency: { type: "string" },
      "price-in": { type: "string" },
      "price-out": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const dir = path.resolve(positionals[0] ?? path.join("examples", "cases"));
  const modes = values.modes.split(",").map((m) => m.trim()) as AnyMode[];
  for (const m of modes) if (!(ALL_MODES as readonly string[]).includes(m)) throw new Error(`Unknown mode ${m}`);

  loadDotEnv();
  const config = loadConfig();
  let cases = await loadCases(dir);
  if (values.only) {
    const ids = new Set(values.only.split(","));
    cases = cases.filter((c) => ids.has(c.id));
  }
  if (!cases.length) throw new Error(`No cases found in ${dir}`);
  const runs = Math.max(1, int("runs", values.runs, 3));
  console.log(`Running ${cases.length} case(s) x ${modes.join(", ")} x ${runs} run(s) with ${config.model} @ ${safeHost(config.baseUrl)}`);

  const report = await runBenchmark(cases, config, buildProvider(config), {
    modes,
    runs,
    seed: int("seed", values.seed, 42),
    concurrency: Math.max(1, int("concurrency", values.concurrency, 1)),
    log: (m) => console.log(m),
  });

  let cost: { usd: number; note: string } | undefined;
  if (values["price-in"] !== undefined && values["price-out"] !== undefined) {
    const pin = Number(values["price-in"]);
    const pout = Number(values["price-out"]);
    const prompt = report.summary.reduce((s, m) => s + m.tokens_sum.prompt, 0);
    const completion = report.summary.reduce((s, m) => s + m.tokens_sum.completion, 0);
    cost = {
      usd: (prompt * pin + completion * pout) / 1_000_000,
      note: `${prompt} prompt + ${completion} completion tokens of successful reviews at $${pin}/$${pout} per 1M; failed calls not included`,
    };
  }

  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });
  const base = path.join(outDir, fileTimestamp(new Date(report.created_at)));
  await writeFile(`${base}.json`, `${JSON.stringify({ ...report, ...(cost ? { cost_estimate: cost } : {}) }, null, 2)}\n`, "utf8");
  const md = toMarkdown(report, cost);
  await writeFile(`${base}.md`, md, "utf8");
  console.log(`\n${md}`);
  console.log(`Saved ${base}.json and ${base}.md`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
