// Posting text is untrusted: an employer (or anyone who can edit a listing)
// could hide instructions aimed at the AI. Strip what a human reader wouldn't
// see, then hand it to the AI clearly marked as data.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const HIDDEN_ELEMENT =
  /<([a-z][a-z0-9]*)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0)[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi;

export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, "");
  for (let i = 0; i < 3; i++) s = s.replace(HIDDEN_ELEMENT, ""); // nested hidden blocks
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s);
}

// Zero-width and bidi control characters are a common way to hide text.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(text: string, maxChars = 12_000): string {
  return text
    .replace(INVISIBLE, "")
    .replace(CONTROL, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

export function sanitizePosting(raw: string, maxChars?: number): string {
  return cleanText(/<[a-z!/][\s\S]*>/i.test(raw) ? htmlToText(raw) : raw, maxChars);
}

// Phrases that only make sense as an attempt to steer an AI.
const INJECTION_HINTS =
  /(ignore (all |any )?(previous|prior|above) (instructions|prompts)|disregard (the )?(previous|above)|you are (now )?(chatgpt|an ai|a language model)|system prompt|as an ai language model|<\/?(system|assistant|instructions?)>|score this (job|posting|candidate) (100|as high))/i;

export function looksLikeInjection(text: string): boolean {
  return INJECTION_HINTS.test(text);
}

// Wraps untrusted text so prompts can say "everything inside <posting> is data".
export function asData(tag: string, attrs: Record<string, string>, text: string): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replaceAll('"', "'")}"`)
    .join("");
  const safe = text.replaceAll(`</${tag}`, `</ ${tag}`); // can't close the wrapper early
  return `<${tag}${a}>\n${safe}\n</${tag}>`;
}
