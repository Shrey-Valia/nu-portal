// Deterministic checks on every cover letter and written answer, run after the
// humanizer. Anything that fails is held for your review instead of being sent.

export interface LintResult {
  ok: boolean;
  problems: string[];
}

export interface LintOptions {
  kind: "cover_letter" | "answer";
  employer?: string;
  maxChars?: number;
  // Text the writing is allowed to draw numbers from (draft, profile facts, posting).
  sources?: string[];
}

const SUSPICIOUS = /(ignore (all )?(previous|prior) instructions|as an ai|language model|i cannot (help|assist)|i'?m sorry, but|\bchatgpt\b|\bclaude\b|\bprompt\b)/i;
const PLACEHOLDER = /(\[(company|name|role|position|employer|hiring manager|your name)[^\]]*\]|\{\{|\}\}|<(company|name)>|lorem ipsum|xx+\b|\bTBD\b)/i;
const MARKDOWN = /(\*\*|__|^#{1,6}\s|^\s*[-*]\s+\*\*|```)/m;
const URL = /\bhttps?:\/\/|\bwww\./i;

export function lintWriting(text: string, opts: LintOptions): LintResult {
  const problems: string[] = [];
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  if (!text.trim()) problems.push("empty");
  if (SUSPICIOUS.test(text)) problems.push("contains AI or instruction-like wording");
  if (PLACEHOLDER.test(text)) problems.push("contains a placeholder");
  if (MARKDOWN.test(text)) problems.push("contains markdown formatting");
  if (URL.test(text)) problems.push("contains a link");

  if (opts.kind === "cover_letter") {
    if (words < 120) problems.push(`too short (${words} words, want 180-350)`);
    if (words > 420) problems.push(`too long (${words} words, want 180-350)`);
    if (opts.employer && !mentions(text, opts.employer)) problems.push(`never mentions ${opts.employer}`);
  } else {
    const max = opts.maxChars ?? 2500;
    if (text.length > max) problems.push(`too long (${text.length} of ${max} characters)`);
  }

  if (opts.sources?.length) {
    const allowed = new Set(opts.sources.flatMap(numbersIn));
    const invented = numbersIn(text).filter((n) => !allowed.has(n) && !TRIVIAL.has(n));
    if (invented.length) problems.push(`numbers not found in your profile or the posting: ${[...new Set(invented)].slice(0, 5).join(", ")}`);
  }

  return { ok: problems.length === 0, problems };
}

const TRIVIAL = new Set(["1", "2", "3", "one", "two", "three"]);

function numbersIn(s: string): string[] {
  return (s.match(/\d+(?:[.,]\d+)?%?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

// "Acme Robotics, Inc." counts as mentioned if "Acme Robotics" or "Acme" appears.
function mentions(text: string, employer: string): boolean {
  const t = text.toLowerCase();
  const clean = employer.replace(/,?\s*(inc|llc|ltd|corp|corporation|co)\.?$/i, "").trim().toLowerCase();
  if (t.includes(clean)) return true;
  const first = clean.split(/\s+/)[0];
  return first.length >= 4 && t.includes(first);
}

export function checkClaims(claims: { text: string; sourceId: string }[], known: Set<string>): string[] {
  return claims.filter((c) => !known.has(c.sourceId)).map((c) => `claim cites unknown source "${c.sourceId}": ${c.text.slice(0, 80)}`);
}
