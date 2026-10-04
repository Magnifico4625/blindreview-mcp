import { createHash } from "node:crypto";
import type { AnyMode } from "../src/schemas/review.js";
import type { BenchmarkCase } from "./cases.js";
import { reviewText, type RunRecord } from "./metrics.js";
import { rng, shuffle, wilson, type Rate } from "./stats.js";

/**
 * Human review support (no LLM judge). For every successful result and every required observation
 * of its case, the sheet has one row with an empty `hit` column (yes/no) to be filled by a person.
 * Rows are shuffled and the mode is hidden behind an opaque item id; the key file maps ids back.
 */
export interface SheetKey {
  label: string;
  created_at: string;
  items: Record<string, { case_id: string; run: number; mode: AnyMode }>;
}

export function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 parser (handles quotes, embedded newlines, CRLF/LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export const SHEET_COLUMNS = ["item_id", "case_id", "observation_index", "required_observation", "verdict", "review_text", "hit"] as const;

export function exportSheet(label: string, cases: BenchmarkCase[], records: RunRecord[], seed = 99): { csv: string; key: SheetKey } {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const key: SheetKey = { label, created_at: new Date().toISOString(), items: {} };
  const rows: string[][] = [];
  for (const r of records) {
    const c = byId.get(r.case_id);
    if (!r.ok || !r.result || !c || !c.ground_truth.required_observations.length) continue;
    const id = createHash("sha256").update(`${label}|${r.case_id}|${r.run}|${r.mode}`).digest("hex").slice(0, 10);
    key.items[id] = { case_id: r.case_id, run: r.run, mode: r.mode };
    c.ground_truth.required_observations.forEach((obs, i) => {
      rows.push([id, r.case_id, String(i), obs, r.result!.verdict, reviewText(r.result!), ""]);
    });
  }
  const shuffled = shuffle(rows, rng(seed));
  const csv = [SHEET_COLUMNS.join(","), ...shuffled.map((r) => r.map(csvEscape).join(","))].join("\r\n") + "\r\n";
  return { csv, key };
}

export interface ObservationCoverage {
  mode: AnyMode;
  rows: number;
  filled: number;
  hit: Rate;
  /** Results where ALL required observations were marked yes. */
  all_hit: Rate;
}

export function ingestSheet(csv: string, key: SheetKey): ObservationCoverage[] {
  const [head, ...data] = parseCsv(csv);
  if (!head) throw new Error("Empty sheet");
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i === -1) throw new Error(`Sheet is missing column ${name}`);
    return i;
  };
  const iId = col("item_id");
  const iHit = col("hit");
  const perMode = new Map<AnyMode, { rows: number; filled: number; yes: number; items: Map<string, boolean> }>();
  for (const row of data) {
    const item = key.items[row[iId] ?? ""];
    if (!item) throw new Error(`Unknown item_id ${row[iId]}`);
    const m = perMode.get(item.mode) ?? { rows: 0, filled: 0, yes: 0, items: new Map() };
    m.rows++;
    const v = (row[iHit] ?? "").trim().toLowerCase();
    if (v) {
      const yes = ["yes", "y", "1", "true", "да"].includes(v);
      const no = ["no", "n", "0", "false", "нет"].includes(v);
      if (!yes && !no) throw new Error(`hit must be yes/no, got ${JSON.stringify(row[iHit])}`);
      m.filled++;
      if (yes) m.yes++;
      const id = row[iId] as string;
      m.items.set(id, (m.items.get(id) ?? true) && yes);
    } else {
      m.items.set(row[iId] as string, false);
    }
    perMode.set(item.mode, m);
  }
  return [...perMode.entries()].map(([mode, m]) => ({
    mode,
    rows: m.rows,
    filled: m.filled,
    hit: wilson(m.yes, m.filled),
    all_hit: wilson([...m.items.values()].filter(Boolean).length, m.items.size),
  }));
}
