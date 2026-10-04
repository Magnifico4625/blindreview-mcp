import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config.js";
import { Telemetry } from "../telemetry/telemetry.js";

const USAGE = `Usage: npm run outcome -- <review_id> [--accepted true|false] [--rework true|false] [--useful true|false]

  --accepted   the main agent/user accepted the review's recommendation
  --rework     the decision later required rework anyway
  --useful     the review was useful (caught something / changed the plan)`;

function bool(name: string, v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (["true", "yes", "1", "y"].includes(s)) return true;
  if (["false", "no", "0", "n"].includes(s)) return false;
  throw new Error(`--${name} must be true or false, got ${JSON.stringify(v)}`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      accepted: { type: "string" },
      rework: { type: "string" },
      useful: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const id = positionals[0];
  if (values.help || !id) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const outcome = {
    review_id: id,
    accepted_review: bool("accepted", values.accepted),
    later_rework_required: bool("rework", values.rework),
    review_was_useful: bool("useful", values.useful),
  };
  if (outcome.accepted_review === undefined && outcome.later_rework_required === undefined && outcome.review_was_useful === undefined) {
    console.error("Nothing to record: pass at least one of --accepted, --rework, --useful.");
    return 1;
  }
  loadDotEnv();
  const config = loadConfig();
  if (!config.telemetryEnabled) {
    console.error("Telemetry is disabled. Set TELEMETRY_ENABLED=true in .env to record outcomes.");
    return 1;
  }
  const telemetry = new Telemetry(true, config.telemetryPath);
  const known = (await telemetry.readAll()).some((r) => r.type === "review" && r.id === id);
  if (!known) console.warn(`Warning: review ${id} not found in ${config.telemetryPath}; recording anyway.`);
  const ok = await telemetry.recordOutcome(outcome);
  console.log(ok ? `Outcome recorded for ${id} in ${config.telemetryPath}` : "Failed to write outcome.");
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
