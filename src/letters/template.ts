import type { Profile } from "../me/schema.js";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export interface LetterDoc {
  profile: Profile;
  employer: string;
  title: string;
  body: string; // greeting, paragraphs, sign-off; blank lines separate paragraphs
  date: string; // e.g. "October 6, 2026"
}

// Header and layout are filled by code; only the body comes from the AI.
export function letterHtml(doc: LetterDoc): string {
  const id = doc.profile.identity;
  const contact = [id.city, id.email, id.phone, id.links.linkedin?.replace(/^https?:\/\/(www\.)?/, ""), id.links.github?.replace(/^https?:\/\//, "")]
    .filter(Boolean)
    .map((s) => esc(s!))
    .join(" &middot; ");
  const paragraphs = doc.body
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(`${id.name} - ${doc.employer}`)}</title>
<style>
  @page { size: Letter; margin: 0.9in 1in; }
  body { font: 11pt/1.45 Georgia, "Times New Roman", serif; color: #111; }
  header { border-bottom: 1px solid #999; padding-bottom: 8pt; margin-bottom: 18pt; }
  h1 { font: 600 17pt/1.2 -apple-system, "Helvetica Neue", Arial, sans-serif; margin: 0 0 4pt; letter-spacing: 0.2pt; }
  .contact { font: 9.5pt/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #333; }
  .meta { margin-bottom: 14pt; }
  p { margin: 0 0 10pt; }
</style></head>
<body>
<header><h1>${esc(id.name)}</h1><div class="contact">${contact}</div></header>
<div class="meta">${esc(doc.date)}<br>${esc(doc.employer)}<br>Re: ${esc(doc.title)}</div>
${paragraphs}
</body></html>`;
}
