import { existsSync } from "node:fs";
import path from "node:path";
import { ME_DIR } from "../config/paths.js";
import { loadMe } from "../me/load.js";

// Prints what NU Portal knows about you, and what's missing.
export default async function profileCheck(): Promise<number> {
  const me = loadMe();
  const p = me.profile;
  const line = (k: string, v: string) => console.log(`  ${k.padEnd(16)} ${v}`);

  console.log(`\n${p.identity.name}${p.identity.preferredName ? ` (${p.identity.preferredName})` : ""}`);
  line("city", p.identity.city ?? "—");
  line("links", Object.entries(p.identity.links).filter(([, v]) => v).map(([k]) => k).join(", ") || "—");
  console.log("\nEducation");
  line("program", `${p.education.degree} ${p.education.majors.join(" + ")}${p.education.minors.length ? `, minor ${p.education.minors.join(", ")}` : ""}`);
  line("graduates", p.education.gradDate);
  line("co-op", `#${p.education.coopNumber}, ${p.education.coopCycle}`);
  line("GPA", p.education.gpa ? `${p.education.gpa}${p.education.shareGpa ? "" : " (not shared)"}` : "—");
  console.log("\nWork authorization");
  line("authorized", p.workAuth.authorizedUS ? "yes" : "no");
  line("sponsorship", p.workAuth.needsSponsorship ? "needed" : "not needed");
  console.log("\nWhat you want");
  line("roles", p.targets.roles.join(", "));
  line("domains", p.targets.domains.join(", ") || "—");
  line("locations", `${p.targets.locations.join(", ") || "anywhere"}${p.targets.willingToRelocate ? " (will relocate)" : ""}`);
  line("modalities", p.targets.modalities.join(", "));
  line("min pay", p.targets.minHourly ? `$${p.targets.minHourly}/hr` : "—");
  line("avoid", [...p.targets.companiesAvoid, ...p.targets.keywordsAvoid].join(", ") || "—");
  console.log("\nWhat you've done");
  line("skills", p.skills.map((s) => `${s.name} (${s.level})`).join(", ") || "—");
  for (const e of p.experiences) line(e.kind, `${e.title} @ ${e.org} — ${e.bullets.length} bullet${e.bullets.length === 1 ? "" : "s"}`);
  line("stories", me.stories.map((s) => s.id).join(", ") || "—");
  line("answer bank", `${me.answers.length} answers`);

  const gaps: string[] = [];
  if (!me.files.resume) gaps.push("me/resume.pdf missing (needed to apply)");
  if (!me.files.linkedin) gaps.push("me/linkedin.pdf missing (optional, LinkedIn → More → Save to PDF)");
  if (!existsSync(path.join(ME_DIR, "private.yaml"))) gaps.push("me/private.yaml missing (copy templates/me/private.example.yaml)");
  if (me.stories.length < 3) gaps.push(`only ${me.stories.length} stories; 3-6 makes letters much better`);
  if (!me.voice.trim()) gaps.push("me/voice.md is empty; the humanizer works better with your voice notes");
  if (me.answers.length < 5) gaps.push("me/answers.yaml has few answers; external applications will need more");
  if (!me.files.samples.length) gaps.push("no writing samples in me/samples/");
  const noEvidence = p.skills.filter((s) => !s.evidence.length).map((s) => s.name);
  if (noEvidence.length) gaps.push(`skills with no evidence: ${noEvidence.join(", ")}`);

  console.log(gaps.length ? `\nGaps\n${gaps.map((g) => `  ! ${g}`).join("\n")}` : "\nNo gaps found.");
  console.log(`\nProfile version ${me.version}\n`);
  return 0;
}
