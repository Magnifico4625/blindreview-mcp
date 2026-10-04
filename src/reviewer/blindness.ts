import type { BlindInput, ReviewInput } from "../schemas/review.js";
import { toBlindInput } from "../schemas/review.js";

/**
 * Deterministic leak check for the blindness contract.
 * The blind fields (objective, constraints, context, environment, evidence) are written by the
 * calling agent, so its plan can leak into them. We measure CONTAINMENT: the share of the
 * proposal's word n-grams (shingles, n=5) that also occur in the blind fields.
 *   0   = no shared 5-word phrase,  1 = every 5-word phrase of the proposal is already visible.
 * Containment (not Jaccard) is used because the context is usually much longer than the proposal.
 */
export const SHINGLE_SIZE = 5;

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function shingles(text: string, n = SHINGLE_SIZE): Set<string> {
  const w = words(text);
  const size = Math.min(n, w.length);
  const out = new Set<string>();
  if (size === 0) return out;
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(" "));
  return out;
}

export function blindText(b: BlindInput): string {
  return [b.objective, ...b.constraints, b.context, b.environment ?? "", ...(b.evidence ?? [])].join("\n");
}

export function proposalContainment(input: ReviewInput): number {
  // Short proposals (< 5 words) are compared with n = their word count.
  const n = Math.min(SHINGLE_SIZE, words(input.proposed_solution).length);
  const proposal = shingles(input.proposed_solution, n);
  if (proposal.size === 0) return 0;
  const visible = shingles(blindText(toBlindInput(input)), n);
  let shared = 0;
  for (const s of proposal) if (visible.has(s)) shared++;
  return shared / proposal.size;
}
