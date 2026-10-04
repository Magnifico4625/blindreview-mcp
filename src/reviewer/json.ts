/**
 * Extract a JSON object from model output. Handles: plain JSON, ```json fences,
 * <think>...</think> preambles (local reasoning models) and prose around a single object.
 * Returns undefined when no parseable object is found.
 */
export function extractJson(text: string): unknown {
  let t = text.replace(/^\uFEFF/, "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!t) return undefined;
  const direct = tryParse(t);
  if (direct !== undefined) return direct;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
    t = fence[1];
  }
  const start = t.indexOf("{");
  if (start === -1) return undefined;
  const end = findMatchingBrace(t, start);
  if (end === -1) return undefined;
  return tryParse(t.slice(start, end + 1));
}

function tryParse(s: string): unknown {
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function findMatchingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Light, lossless-ish normalisation of common model quirks before strict Zod validation. */
export function normalizeVerdictCandidate(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const v = { ...(value as Record<string, unknown>) };
  for (const key of ["critical_assumptions", "material_risks"]) v[key] = clampList(v[key], 10);
  if (typeof v.verdict === "string") v.verdict = v.verdict.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (typeof v.confidence === "string" && v.confidence.trim() !== "") v.confidence = Number(v.confidence);
  if (typeof v.confidence === "number" && v.confidence > 1 && v.confidence <= 100) v.confidence = v.confidence / 100;
  if (v.better_alternative === null || (typeof v.better_alternative === "string" && v.better_alternative.trim() === "")) {
    delete v.better_alternative;
  }
  if (typeof v.better_alternative === "string" && /^(none|n\/a|no|null)\.?$/i.test(v.better_alternative.trim())) {
    delete v.better_alternative;
  }
  return v;
}

/** Same idea for the internal Phase 1 position. */
export function normalizePositionCandidate(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const v = { ...(value as Record<string, unknown>) };
  for (const key of ["main_assumptions", "failure_modes", "assumptions_to_test"]) v[key] = clampList(v[key], 12);
  if (Array.isArray(v.directions)) v.directions = v.directions.slice(0, 5);
  return v;
}

function clampList(value: unknown, max: number): unknown {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.slice(0, max) : value;
}
