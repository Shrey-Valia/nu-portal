import type { Profile } from "../me/schema.js";

// One-page resume built from your profile. With `tailored`, skills and bullets
// come in the tailored order and wording; everything else is your profile as is.

export interface ResumeContent {
  skillGroups: { label: string; skills: string[] }[];
  bullets: Record<string, string[]>; // experience id -> bullet texts, in order
}

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-06" -> "Jun 2026"; anything else as written.
function when(s: string | undefined): string {
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : s;
}

const SECTIONS: { title: string; kinds: Profile["experiences"][number]["kind"][] }[] = [
  { title: "Experience", kinds: ["job", "coop", "internship", "research"] },
  { title: "Projects", kinds: ["project"] },
  { title: "Leadership & Activities", kinds: ["leadership", "volunteer", "course"] },
];

export function untailored(profile: Profile): ResumeContent {
  return {
    skillGroups: profile.skills.length ? [{ label: "Skills", skills: profile.skills.map((s) => s.name) }] : [],
    bullets: Object.fromEntries(profile.experiences.map((e) => [e.id, e.bullets.map((b) => b.text)])),
  };
}

export function resumeHtml(profile: Profile, content: ResumeContent, fontPt = 10.5): string {
  const id = profile.identity;
  const ed = profile.education;
  const links = [id.links.linkedin, id.links.github, id.links.website, id.links.portfolio]
    .filter(Boolean)
    .map((u) => u!.replace(/^https?:\/\/(www\.)?/, "").replace(/[/?#.,;]+$/, ""));
  const contact = [id.city, id.email, id.phone, ...links].filter(Boolean).map((s) => esc(s!)).join(" &nbsp;|&nbsp; ");
  const majors = ed.majors.join(" & ");
  // Some profiles store the full degree ("Bachelor of Science in X"); don't repeat the major.
  const degree = !ed.degree ? majors : ed.majors.every((m) => ed.degree.toLowerCase().includes(m.toLowerCase())) ? ed.degree : `${ed.degree} in ${majors}`;
  const eduLine2 = [
    ed.minors.length ? `Minor: ${ed.minors.join(", ")}` : "",
    ed.shareGpa && ed.gpa ? `GPA: ${ed.gpa.toFixed(2)}` : "",
    ed.coopCycle ? `Available for co-op: ${ed.coopCycle}` : "",
  ].filter(Boolean);

  const section = (title: string, kinds: string[]) => {
    const items = profile.experiences.filter((e) => kinds.includes(e.kind));
    if (!items.length) return "";
    return `<h2>${esc(title)}</h2>${items
      .map((e) => {
        const dates = [when(e.start), e.end ? when(e.end) : e.start ? "Present" : ""].filter(Boolean).join(" – ");
        const bullets = content.bullets[e.id] ?? e.bullets.map((b) => b.text);
        return `<div class="item">
          <div class="row"><span><b>${esc(e.title)}</b>${e.org && !/^personal project$/i.test(e.org) && !e.title.toLowerCase().includes(e.org.toLowerCase()) ? `, ${esc(e.org)}` : ""}${e.tech.length && e.kind === "project" ? ` <span class="tech">| ${esc(e.tech.join(", "))}</span>` : ""}</span><span class="right">${esc([e.location, dates].filter(Boolean).join(" · "))}</span></div>
          ${bullets.length ? `<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
        </div>`;
      })
      .join("")}`;
  };

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(`${id.name} Resume`)}</title>
<style>
  @page { size: Letter; margin: 0.5in 0.6in; }
  body { font: ${fontPt}pt/1.3 "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: ${fontPt * 1.9}pt; margin: 0 0 2pt; text-align: center; letter-spacing: .3pt; }
  .contact { text-align: center; font-size: ${fontPt - 1}pt; color: #333; margin-bottom: 6pt; }
  h2 { font-size: ${fontPt + 0.5}pt; text-transform: uppercase; letter-spacing: .8pt; border-bottom: 1px solid #222; margin: 8pt 0 4pt; padding-bottom: 1pt; }
  .row { display: flex; justify-content: space-between; gap: 12pt; }
  .right { white-space: nowrap; color: #333; }
  .tech { font-weight: normal; color: #333; }
  .item { margin-bottom: 4pt; break-inside: avoid; }
  ul { margin: 1pt 0 0 14pt; padding: 0; }
  li { margin: 0 0 1pt; }
  .skills div { margin-bottom: 1pt; }
</style></head><body>
<h1>${esc(id.name)}</h1>
<div class="contact">${contact}</div>
<h2>Education</h2>
<div class="item">
  <div class="row"><span><b>${esc(ed.school)}</b>${ed.college ? `, ${esc(ed.college)}` : ""}</span><span class="right">Expected ${esc(ed.gradDate)}</span></div>
  <div>${esc(degree)}${eduLine2.length ? ` &nbsp;|&nbsp; ${eduLine2.map(esc).join(" &nbsp;|&nbsp; ")}` : ""}</div>
  ${ed.coursework.length ? `<div>Relevant coursework: ${esc(ed.coursework.join(", "))}</div>` : ""}
</div>
${SECTIONS.map((s) => section(s.title, s.kinds)).join("")}
${content.skillGroups.length ? `<h2>Skills</h2><div class="skills">${content.skillGroups.map((g) => `<div><b>${esc(g.label)}:</b> ${esc(g.skills.join(", "))}</div>`).join("")}</div>` : ""}
${profile.awards.length ? `<h2>Awards</h2><ul>${profile.awards.map((a) => `<li>${esc(a.text)}</li>`).join("")}</ul>` : ""}
${profile.extras.length ? `<div style="margin-top:6pt">${profile.extras.map((x) => esc(x.text)).join(" &nbsp;|&nbsp; ")}</div>` : ""}
</body></html>`;
}
