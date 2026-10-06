import { normalizeName } from "../core/dedupe.js";
import type { AnswerBank } from "../me/schema.js";

// Your own answers win over the AI. Picks the entry whose match phrases best
// cover the question; requires at least one whole-phrase hit.
export function answerFromBank(bank: AnswerBank, question: string): { id: string; answer: string } | null {
  const q = ` ${normalizeName(question)} `;
  let best: { id: string; answer: string; score: number } | null = null;
  for (const entry of bank) {
    const hits = entry.match.filter((m) => q.includes(` ${normalizeName(m)} `));
    if (!hits.length) continue;
    const score = hits.reduce((s, h) => s + h.length, 0);
    if (!best || score > best.score) best = { id: entry.id, answer: entry.answer, score };
  }
  return best ? { id: best.id, answer: best.answer } : null;
}

// Fuzzy match a desired value to one of a field's options.
export function pickOption(options: string[], desired: string): string | null {
  const d = normalizeName(desired);
  if (!d) return null;
  const exact = options.find((o) => normalizeName(o) === d);
  if (exact) return exact;
  const starts = options.filter((o) => normalizeName(o).startsWith(d) || d.startsWith(normalizeName(o)));
  if (starts.length === 1) return starts[0];
  const contains = options.filter((o) => normalizeName(o).includes(d));
  return contains.length === 1 ? contains[0] : null;
}
