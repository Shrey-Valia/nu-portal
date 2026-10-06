import "./helpers.js";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { createAshbyAdapter } from "../src/ats/ashby.js";
import { classifyRole, matchLocation, matchNumericRange, matchOption, parseLooseDate, pickDecline } from "../src/ats/common.js";
import { applyUrlFor, detectAts } from "../src/ats/detect.js";
import { createGreenhouseAdapter, greenhouseIds } from "../src/ats/greenhouse.js";
import { ADAPTERS, adapterFor } from "../src/ats/index.js";
import { createLeverAdapter } from "../src/ats/lever.js";
import { splitName, standardFillPlan } from "../src/ats/standard-values.js";
import type { ApplyForm, FormField } from "../src/ats/types.js";
import { PrivateSchema, ProfileSchema } from "../src/me/schema.js";
import { TMP } from "./helpers.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "synthetic", "ats");
const LEVER_ID = "5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f";
const ASHBY_ID = "7d1f0b9e-2c3a-4b5d-8e6f-1a2b3c4d5e6f";

interface Hit {
  method: string;
  path: string;
  type: string;
  body: string;
}
const hits: Hit[] = [];

function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const p = url.pathname;
      hits.push({ method: req.method ?? "GET", path: p + url.search, type: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("latin1") });
      const file = (status: number, name: string, type = "text/html; charset=utf-8") => {
        res.writeHead(status, { "content-type": type });
        res.end(readFileSync(path.join(FIX, name)));
      };
      const redirect = (to: string) => {
        res.writeHead(303, { location: to });
        res.end();
      };
      const get = req.method === "GET";
      if (get && p === "/greenhouse/acme/jobs/4000123") return file(200, "greenhouse.html");
      if (get && p === "/greenhouse/acme/jobs/4000123/confirmation") return file(200, "greenhouse-confirmation.html");
      if (!get && p === "/submit/greenhouse") return redirect("/greenhouse/acme/jobs/4000123/confirmation");
      if (get && p === "/greenhouse-legacy/acme/jobs/4000456") return file(200, "greenhouse-legacy.html");
      if (get && p === "/greenhouse-legacy/acme/jobs/4000456/confirmation") return file(200, "greenhouse-confirmation.html");
      if (!get && p === "/submit/greenhouse-legacy") return redirect("/greenhouse-legacy/acme/jobs/4000456/confirmation");
      if (get && p === "/greenhouse/captchaco/jobs/4000789") return file(200, "captcha.html");
      if (get && p === "/gh-api/v1/boards/acme/jobs/4000123") return file(200, "gh-api-acme.json", "application/json");
      if (get && p === `/lever/acme/${LEVER_ID}/apply`) return file(200, "lever.html");
      if (!get && p === `/lever/acme/${LEVER_ID}/apply`) return redirect(`/lever/acme/${LEVER_ID}/thanks`);
      if (get && p === `/lever/acme/${LEVER_ID}/thanks`) return file(200, "lever-thanks.html");
      if (get && /^\/lever\/acme\/[^/]+\/apply$/.test(p)) return file(404, "lever-404.html");
      if (get && p === `/ashby/acme/${ASHBY_ID}/application`) return file(200, "ashby.html");
      if (!get && p === "/submit/ashby") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"ok":true}');
      }
      if (get && p === "/recaptcha/api2/anchor") return file(200, "recaptcha-anchor.html");
      if (get && p === "/recaptcha/enterprise/anchor") return file(200, "blank.html");
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let server: Server;
let browser: Browser;
let base = "";
const RESUME = path.join(TMP, "Jane_Husky_Resume.pdf");
const LETTER = path.join(TMP, "Jane_Husky_Cover_Letter.pdf");

const profile = ProfileSchema.parse({
  identity: {
    name: "Jane Husky",
    preferredName: "Jane",
    email: "husky.j@example.edu",
    phone: "+1 617 555 0100",
    city: "Boston, MA",
    links: { linkedin: "https://www.linkedin.com/in/janehusky", github: "https://github.com/janehusky", website: "https://janehusky.dev" },
  },
  education: { school: "Northeastern University", degree: "BS", majors: ["Computer Science"], gradDate: "May 2028", gpa: 3.7, coopCycle: "Spring 2027", coopNumber: 1 },
  workAuth: { authorizedUS: true, needsSponsorship: false },
  targets: { roles: ["Software Engineer Co-op"] },
});
const priv = PrivateSchema.parse({}); // declines every EEO question

const field = (form: ApplyForm, key: string): FormField => {
  const f = form.fields.find((x) => x.key === key);
  assert.ok(f, `field ${key} missing; have ${form.fields.map((x) => x.key).join(", ")}`);
  return f;
};

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

before(async () => {
  writeFileSync(RESUME, "%PDF-1.4\n% synthetic resume for tests\n");
  writeFileSync(LETTER, "%PDF-1.4\n% synthetic cover letter for tests\n");
  server = await startServer();
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  base = `http://127.0.0.1:${addr.port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

describe("detection and routing", () => {
  test("detectAts recognizes hosts, embeds and job-id params", () => {
    const cases: [string, string][] = [
      ["https://boards.greenhouse.io/acme/jobs/4012345", "greenhouse"],
      ["https://job-boards.greenhouse.io/acme/jobs/4012345", "greenhouse"],
      ["https://job-boards.eu.greenhouse.io/acme/jobs/4012345", "greenhouse"],
      ["https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345", "greenhouse"],
      ["https://careers.acme.com/positions/4012345?gh_jid=4012345", "greenhouse"],
      ["https://jobs.lever.co/acme/5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f", "lever"],
      ["https://jobs.eu.lever.co/acme/5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f/apply", "lever"],
      ["https://jobs.ashbyhq.com/acme/7d1f0b9e-2c3a-4b5d-8e6f-1a2b3c4d5e6f", "ashby"],
      ["https://www.acme.com/careers?ashby_jid=7d1f0b9e-2c3a-4b5d-8e6f-1a2b3c4d5e6f", "ashby"],
      ["https://acme.wd5.myworkdayjobs.com/en-US/External/job/Boston/Engineer_R123", "workday"],
      ["https://careers-acme.icims.com/jobs/1234/engineer/job", "icims"],
      ["https://acme.taleo.net/careersection/2/jobdetail.ftl?job=123", "taleo"],
      ["https://jobs.smartrecruiters.com/Acme/743999-engineer", "smartrecruiters"],
      ["https://jobs.jobvite.com/acme/job/oAbCdEf", "jobvite"],
      ["https://acme.com/careers/123", "other"],
      ["not a url", "other"],
    ];
    for (const [url, kind] of cases) assert.equal(detectAts(url), kind, url);
  });

  test("applyUrlFor points at the application form", () => {
    assert.equal(applyUrlFor("lever", "https://jobs.lever.co/acme/5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f"), "https://jobs.lever.co/acme/5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f/apply");
    assert.equal(applyUrlFor("lever", "https://jobs.lever.co/acme/5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f/apply"), "https://jobs.lever.co/acme/5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f/apply");
    assert.equal(
      applyUrlFor("lever", "https://jobs.lever.co/acme/5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f?lever-source=github"),
      "https://jobs.lever.co/acme/5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f/apply?lever-source=github",
    );
    assert.equal(applyUrlFor("ashby", "https://jobs.ashbyhq.com/acme/7d1f0b9e-2c3a-4b5d-8e6f-1a2b3c4d5e6f"), "https://jobs.ashbyhq.com/acme/7d1f0b9e-2c3a-4b5d-8e6f-1a2b3c4d5e6f/application");
    assert.equal(applyUrlFor("ashby", "https://jobs.ashbyhq.com/acme"), "https://jobs.ashbyhq.com/acme");
    assert.equal(applyUrlFor("greenhouse", "https://job-boards.greenhouse.io/acme/jobs/4012345"), "https://job-boards.greenhouse.io/acme/jobs/4012345");
  });

  test("adapterFor returns adapters only for supported systems", () => {
    assert.equal(adapterFor("https://job-boards.greenhouse.io/acme/jobs/4012345"), ADAPTERS.greenhouse);
    assert.equal(adapterFor("https://jobs.lever.co/acme/x")?.kind, "lever");
    assert.equal(adapterFor("https://jobs.ashbyhq.com/acme/x")?.kind, "ashby");
    assert.equal(adapterFor("https://acme.wd5.myworkdayjobs.com/x"), null);
    assert.equal(adapterFor("https://acme.com/careers"), null);
    const paced = adapterFor("https://jobs.lever.co/acme/x", { delay: async () => {} });
    assert.ok(paced && paced !== ADAPTERS.lever && paced.kind === "lever");
    assert.deepEqual(greenhouseIds("https://job-boards.greenhouse.io/acme/jobs/4012345"), { board: "acme", id: "4012345" });
    assert.deepEqual(greenhouseIds("https://boards.greenhouse.io/embed/job_app?for=acme&token=77"), { board: "acme", id: "77" });
  });
});

describe("roles and option matching", () => {
  test("classifyRole reads real-world labels", () => {
    const cases: [string, string, Parameters<typeof classifyRole>[2], string][] = [
      ["First Name", "first_name", "text", "first_name"],
      ["Preferred First Name", "preferred_name", "text", "preferred_name"],
      ["What's the name you'd prefer us to use throughout the interview process?", "question_1", "text", "preferred_name"],
      ["Full name", "name", "text", "full_name"],
      ["Legal Name (if different than above)", "question_2", "text", "custom"],
      ["Email", "email", "text", "email"],
      ["Phone", "phone", "tel", "phone"],
      ["Location (City)", "candidate-location", "select", "location"],
      ["Are you currently located in the US?", "question_3", "select", "custom"],
      ["What is your preferred office location?", "question_4", "select", "custom"],
      ["Resume/CV", "resume", "file", "resume"],
      ["Cover Letter", "cover_letter", "file", "cover_letter"],
      ["Would you like to include your LinkedIn profile, personal website or blog?", "question_5", "text", "linkedin"],
      ["GitHub URL", "urls[GitHub]", "text", "github"],
      ["Portfolio URL", "urls[Portfolio]", "text", "website"],
      ["Which university are you currently attending or did you last attend?", "cards[x][field0]", "select", "school"],
      ["Degree", "degree--0", "select", "degree"],
      ["Discipline", "discipline--0", "select", "discipline"],
      ["End date year", "end-year--0", "number", "grad_date"],
      ["If you're less than 3 years out of school, what is your undergraduate GPA?", "question_6", "text", "gpa"],
      ["Are you legally authorized to work in the United States for our Company?", "question_7", "select", "work_authorization"],
      ["Are you authorized to work lawfully in the United States?", "x", "radio", "work_authorization"],
      ["Will you now or in the future require visa sponsorship to work in the US?", "question_8", "select", "sponsorship"],
      ["Are you authorized to work in the US without requiring sponsorship?", "question_9", "select", "work_authorization"],
      ["Gender", "gender", "select", "eeo_gender"],
      ["Are you Hispanic/Latino?", "hispanic_ethnicity", "select", "eeo_hispanic"],
      ["Race and Ethnicity", "4033065002", "select", "eeo_race"],
      ["What is your military status?", "1259", "select", "eeo_veteran"],
      ["Disability Status", "disability_status", "select", "eeo_disability"],
      ["I consider myself a member of the LGBTQ+ community.", "4033070002", "select", "custom"],
      ["Pronouns", "question_10", "select", "custom"],
      ["Country", "country", "select", "address"],
      ["Date of Birth", "dob", "date", "date_of_birth"],
      ["How did you hear about this job?", "question_11", "text", "custom"],
      ["", "_systemfield_eeoc_gender", "radio", "eeo_gender"],
    ];
    for (const [label, name, type, role] of cases) assert.equal(classifyRole(label, name, type), role, `${label} / ${name}`);
  });

  test("matchOption prefers exact, then case-insensitive, leading words, contains; null when ambiguous", () => {
    assert.equal(matchOption(["Yes", "No"], "No"), "No");
    assert.equal(matchOption(["yes", "no"], "Yes"), "yes");
    assert.equal(matchOption(["Yes, I am authorized", "No, I am not authorized"], "Yes"), "Yes, I am authorized");
    assert.equal(matchOption(["J1", "F1", "None", "Other"], "No"), null);
    assert.equal(matchOption(["United States +1", "Canada +1"], "United States"), "United States +1");
    assert.equal(matchOption(["Bachelor's Degree", "Bachelors", "Master's Degree"], "Bachelor"), "Bachelor's Degree");
    assert.equal(matchOption(["Bachelor of Arts", "Bachelor of Science"], "Bachelor"), null);
    assert.equal(matchOption(["Bachelor's Degree", "Master's Degree"], ["BS", "Bachelor's Degree"]), "Bachelor's Degree");
    assert.equal(matchOption(["Undergraduate/Bachelors", "Master's", "PhD"], ["Bachelor's", "Bachelors"]), "Undergraduate/Bachelors");
    assert.equal(matchOption(["East Asian", "South Asian", "White"], "Asian"), null);
    assert.equal(matchOption(["Åland Islands +358", "Albania +355"], "Aland Islands"), "Åland Islands +358");
    assert.equal(pickDecline(["Male", "Female", "I don't wish to answer"]), "I don't wish to answer");
    assert.equal(pickDecline(["Yes", "No, I do not have a disability", "I do not want to answer"]), "I do not want to answer");
    assert.equal(matchNumericRange(["Below 3.0", "3.0 - 3.49", "3.5 - 4.0"], 3.7), "3.5 - 4.0");
    assert.equal(matchLocation(["Boston, Massachusetts, United States", "Boston, Lincolnshire, England", "Boston Heights, Ohio"], "Boston, MA"), "Boston, Massachusetts, United States");
    assert.deepEqual(parseLooseDate("May 2028"), { y: 2028, m: 5, d: 1 });
    assert.deepEqual(parseLooseDate("Spring 2028"), { y: 2028, m: 5, d: 1 });
    assert.deepEqual(splitName("Juan de la Cruz"), { first: "Juan", last: "de la Cruz" });
    assert.deepEqual(splitName("Mary Ann Smith Jr."), { first: "Mary Ann", last: "Smith Jr." });
  });

  test("standardFillPlan sends custom and unmatched questions to unresolved", () => {
    const form: ApplyForm = {
      ats: "greenhouse",
      url: "https://example.test",
      company: null,
      title: null,
      hasCaptcha: false,
      blockers: [],
      fields: [
        { key: "fn", label: "First Name", type: "text", role: "first_name", required: true },
        { key: "why", label: "Why us?", type: "textarea", role: "custom", required: true },
        { key: "spons", label: "Sponsorship?", type: "radio", role: "sponsorship", required: true, options: ["J1", "F1", "None"] },
        { key: "gpa", label: "GPA", type: "select", role: "gpa", required: false, options: ["Below 3.0", "3.0 - 3.49", "3.5 - 4.0"] },
        { key: "vet", label: "Veteran", type: "select", role: "eeo_veteran", required: false, options: ["I am a veteran", "Prefer not to say"] },
        { key: "start", label: "Start date", type: "text", role: "start_date", required: false },
        { key: "addr2", label: "Address line 2", type: "text", role: "address", required: false },
        { key: "dob", label: "Date of birth", type: "date", role: "date_of_birth", required: false },
      ],
    };
    const { plan, unresolved } = standardFillPlan(form, profile, { ...priv, dateOfBirth: "2005-01-31", address: { country: "United States", street: "1 Main St" } }, { resume: RESUME });
    assert.deepEqual(plan, { fn: "Jane", gpa: "3.5 - 4.0", vet: "Prefer not to say", dob: "2005-01-31" });
    assert.deepEqual(unresolved.map((f) => f.key), ["why", "spons", "start"]);
    const noGpa = standardFillPlan(form, { ...profile, education: { ...profile.education, shareGpa: false } }, priv, { resume: RESUME });
    assert.equal(noGpa.plan.gpa, undefined);
    assert.ok(!noGpa.unresolved.some((f) => f.key === "gpa"), "an optional GPA is left blank when shareGpa is false");
  });
});

describe("Greenhouse (job-boards React form)", () => {
  test("open, plan, fill and submit", async () => {
    const gh = createGreenhouseAdapter({ apiBase: `${base}/gh-api`, submitTimeoutMs: 10_000 });
    await withPage(async (page) => {
      const form = await gh.open(page, `${base}/greenhouse/acme/jobs/4000123`);
      assert.deepEqual(form.blockers, []);
      assert.equal(form.hasCaptcha, false, "the invisible reCAPTCHA badge is not a blocker");
      assert.equal(form.title, "Robotics Software Co-op");
      assert.equal(form.company, "Acme Robotics");
      assert.ok(hits.some((h) => h.path.startsWith("/gh-api/v1/boards/acme/jobs/4000123?questions=true")), "public API consulted");

      const roles: Record<string, string> = {
        first_name: "first_name",
        last_name: "last_name",
        preferred_name: "preferred_name",
        email: "email",
        country: "address",
        phone: "phone",
        "candidate-location": "location",
        resume: "resume",
        cover_letter: "cover_letter",
        "school--0": "school",
        "degree--0": "degree",
        "discipline--0": "discipline",
        "end-month--0": "grad_date",
        "end-year--0": "grad_date",
        question_1001: "custom",
        question_1002: "linkedin",
        question_1003: "website",
        question_1004: "work_authorization",
        question_1005: "sponsorship",
        "question_1006[]": "custom",
        question_1007: "custom",
        gender: "eeo_gender",
        hispanic_ethnicity: "eeo_hispanic",
        veteran_status: "eeo_veteran",
        disability_status: "eeo_disability",
      };
      for (const [key, role] of Object.entries(roles)) assert.equal(field(form, key).role, role, key);
      assert.equal(form.fields.length, Object.keys(roles).length, form.fields.map((f) => f.key).join(", "));
      for (const k of ["first_name", "email", "country", "phone", "candidate-location", "resume", "school--0", "question_1001", "question_1006[]"])
        assert.equal(field(form, k).required, true, `${k} required`);
      for (const k of ["preferred_name", "cover_letter", "question_1002", "gender"]) assert.equal(field(form, k).required, false, `${k} optional`);
      assert.equal(field(form, "resume").label, "Resume/CV");
      assert.equal(field(form, "resume").type, "file");
      assert.equal(field(form, "question_1001").description, "A few sentences is plenty.");
      assert.deepEqual(field(form, "question_1004").options, ["Yes", "No"]);
      assert.ok(field(form, "country").options?.includes("United States +1"), "options read by opening the dropdown");
      assert.ok(field(form, "degree--0").options?.includes("Bachelor's Degree"));
      assert.equal(field(form, "school--0").options, undefined, "async search fields have no fixed options");
      assert.equal(field(form, "question_1006[]").type, "checkbox");

      const { plan, unresolved } = standardFillPlan(form, profile, priv, { resume: RESUME, coverLetter: LETTER });
      assert.deepEqual(unresolved.map((f) => f.key).sort(), ["question_1001", "question_1006[]", "question_1007"]);
      assert.equal(plan.country, "United States +1");
      assert.equal(plan["degree--0"], "Bachelor's Degree");
      assert.equal(plan["end-month--0"], "May");
      assert.equal(plan["end-year--0"], "2028");
      assert.equal(plan.question_1004, "Yes");
      assert.equal(plan.question_1005, "No");
      assert.equal(plan.gender, "I don't wish to answer");
      assert.equal(plan.disability_status, "I do not want to answer");
      assert.deepEqual(plan.resume, { file: RESUME });

      // The answer bank / AI layer would answer these.
      plan.question_1001 = "I want to build reliable software for robots that work alongside people.";
      plan["question_1006[]"] = ["Acknowledge/Confirm"];
      plan.question_1007 = "Career fair";

      const report = await gh.fill(page, form, plan);
      assert.deepEqual(report.failed, []);
      assert.equal(report.filled.length, Object.keys(plan).length);
      assert.equal(await page.inputValue("#first_name"), "Jane");
      assert.equal(await page.inputValue("#last_name"), "Husky");
      assert.equal(await page.inputValue("#email"), "husky.j@example.edu");
      assert.equal(await page.inputValue("#end-year--0"), "2028");
      const single = (id: string) => page.locator(`[id="${id}"]`).locator("xpath=ancestor::div[contains(@class,'select__control')]").locator(".select__single-value").innerText();
      assert.equal(await single("country"), "United States +1");
      assert.equal(await single("candidate-location"), "Boston, Massachusetts, United States");
      assert.equal(await single("school--0"), "Northeastern University");
      assert.equal(await single("discipline--0"), "Computer Science");
      assert.equal(await single("question_1004"), "Yes");
      assert.equal(await single("veteran_status"), "I don't wish to answer");
      assert.equal(await page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files?.[0]?.name), "Jane_Husky_Resume.pdf");
      assert.equal(await page.isChecked('[id="question_1006[]_9001"]'), true);

      const result = await gh.submit(page);
      assert.equal(result.status, "submitted", JSON.stringify(result));
      const post = hits.find((h) => h.method === "POST" && h.path === "/submit/greenhouse");
      assert.ok(post, "form posted");
      assert.match(post.body, /husky\.j@example\.edu/);
      assert.match(post.body, /Jane_Husky_Resume\.pdf/);
      assert.match(post.body, /United States \+1/);
    });
  });
});

describe("Greenhouse (legacy boards form)", () => {
  test("validation errors block submit, then a complete form submits", async () => {
    const gh = createGreenhouseAdapter({ apiBase: null, submitTimeoutMs: 8000 });
    await withPage(async (page) => {
      const form = await gh.open(page, `${base}/greenhouse-legacy/acme/jobs/4000456`);
      assert.deepEqual(form.blockers, []);
      assert.equal(form.title, "Robotics Software Co-op");
      const auth = form.fields.find((f) => f.label === "Are you legally authorized to work in the United States?");
      assert.ok(auth, form.fields.map((f) => f.label).join(" | "));
      assert.equal(auth.role, "work_authorization");
      assert.equal(auth.required, true);
      assert.deepEqual(auth.options, ["Yes", "No"]);
      const essay = form.fields.find((f) => f.label === "What excites you about robotics?");
      assert.ok(essay && essay.type === "textarea" && essay.required && essay.role === "custom");
      assert.equal(form.fields.find((f) => f.label === "LinkedIn Profile")?.role, "linkedin");
      assert.equal(field(form, "resume_file").role, "resume");
      assert.equal(field(form, "job_application_gender").role, "eeo_gender");

      const { plan, unresolved } = standardFillPlan(form, profile, priv, { resume: RESUME });
      assert.deepEqual(unresolved.map((f) => f.key), [essay.key]);
      assert.equal(plan.job_application_gender, "Decline To Self Identify");
      const first = await gh.fill(page, form, plan);
      assert.deepEqual(first.failed, [{ key: essay.key, reason: "required field has no value" }]);
      assert.equal(await page.locator("#job_application_veteran_status").evaluate((s) => (s as HTMLSelectElement).selectedOptions[0].text), "I don't wish to answer");

      const blocked = await gh.submit(page);
      assert.equal(blocked.status, "blocked");
      assert.match(blocked.status === "blocked" ? blocked.detail : "", /This field is required/);
      assert.ok(!hits.some((h) => h.path === "/submit/greenhouse-legacy"), "nothing was posted");

      const second = await gh.fill(page, form, { [essay.key]: "Watching a robot arm learn to sort parts." });
      assert.deepEqual(second.failed.filter((f) => f.key === essay.key), []);
      const ok = await gh.submit(page);
      assert.equal(ok.status, "submitted", JSON.stringify(ok));
    });
  });
});

describe("Lever", () => {
  test("open, plan, fill and submit", async () => {
    const lv = createLeverAdapter({ submitTimeoutMs: 10_000 });
    await withPage(async (page) => {
      const form = await lv.open(page, `${base}/lever/acme/${LEVER_ID}/apply`);
      assert.deepEqual(form.blockers, []);
      assert.equal(form.hasCaptcha, false, "invisible hCaptcha is not a blocker");
      assert.equal(form.company, "Acme Robotics");
      assert.equal(form.title, "Robotics Software Co-op");
      const cards = "cards[11111111-aaaa-4bbb-8ccc-000000000001]";
      const supp = "cards[33333333-aaaa-4bbb-8ccc-000000000003]";
      const uni = "cards[22222222-aaaa-4bbb-8ccc-000000000002][field0]";
      const roles: Record<string, string> = {
        "resume-upload-input": "resume",
        name: "full_name",
        email: "email",
        phone: "phone",
        "location-input": "location",
        org: "custom",
        "urls[LinkedIn]": "linkedin",
        "urls[GitHub]": "github",
        "urls[Portfolio]": "website",
        "urls[Other]": "website",
        [`${cards}[field0]`]: "work_authorization",
        [`${cards}[field1]`]: "sponsorship",
        [uni]: "school",
        [`${supp}[field0]`]: "custom",
        [`${supp}[field1]`]: "custom",
        "eeo[gender]": "eeo_gender",
        "eeo[race]": "eeo_race",
        "eeo[veteran]": "eeo_veteran",
        "additional-information": "custom",
      };
      for (const [key, role] of Object.entries(roles)) assert.equal(field(form, key).role, role, key);
      assert.equal(form.fields.length, Object.keys(roles).length, form.fields.map((f) => f.key).join(", "));
      assert.equal(field(form, "name").label, "Full name");
      assert.equal(field(form, "location-input").required, true);
      assert.equal(field(form, "phone").required, false);
      assert.equal(field(form, `${cards}[field0]`).type, "radio");
      assert.equal(field(form, `${cards}[field0]`).required, true);
      assert.deepEqual(field(form, `${supp}[field0]`).options, ["Python", "TypeScript", "Java", "C++"]);
      assert.equal(field(form, `${supp}[field1]`).description, "Keep it under 200 words.");
      assert.equal(field(form, uni).options?.includes("Click Here (If you encounter an issue, make sure your browser is updated)"), false);

      const { plan, unresolved } = standardFillPlan(form, profile, priv, { resume: RESUME });
      assert.deepEqual(unresolved.map((f) => f.key).sort(), ["additional-information", "org", `${supp}[field0]`, `${supp}[field1]`].sort());
      assert.equal(plan[uni], "Northeastern University");
      assert.equal(plan[`${cards}[field0]`], "Yes");
      assert.equal(plan[`${cards}[field1]`], "No");
      assert.equal(plan["eeo[race]"], "Decline to self-identify");
      assert.equal(plan["urls[Other]"], "https://janehusky.dev");
      plan[`${supp}[field0]`] = ["Python", "TypeScript"];
      plan[`${supp}[field1]`] = "A robot that sorts recycling at home.";

      const report = await lv.fill(page, form, plan);
      assert.deepEqual(report.failed, []);
      assert.ok(report.skipped.some((s) => s.key === "org"));
      assert.equal(await page.inputValue("[name=name]"), "Jane Husky", "typed after the resume parser pre-filled it");
      assert.equal(await page.inputValue("#location-input"), "Boston, MA, United States");
      assert.match(await page.inputValue("#selected-location"), /Boston, MA/);
      assert.equal(await page.isChecked(`[name="${cards}[field0]"][value=Yes]`), true);
      assert.equal(await page.isChecked(`[name="${cards}[field1]"][value=No]`), true);
      assert.equal(await page.isChecked(`[name="${supp}[field0]"][value=TypeScript]`), true);
      assert.equal(await page.isChecked(`[name="${supp}[field0]"][value=Java]`), false);
      assert.equal(await page.inputValue(`[name="${uni}"]`), "Northeastern University");
      assert.equal(await page.inputValue("[name='eeo[veteran]']"), "Decline to self-identify");

      const result = await lv.submit(page);
      assert.equal(result.status, "submitted", JSON.stringify(result));
      assert.match(page.url(), /\/thanks$/);
      const post = hits.find((h) => h.method === "POST" && h.path === `/lever/acme/${LEVER_ID}/apply`);
      assert.ok(post && /multipart\/form-data/.test(post.type));
      assert.match(post.body, /Jane Husky/);
      assert.match(post.body, /Jane_Husky_Resume\.pdf/);
    });
  });

  test("a closed posting is a blocker", async () => {
    const lv = createLeverAdapter();
    await withPage(async (page) => {
      const form = await lv.open(page, `${base}/lever/acme/00000000-0000-4000-8000-000000000000/apply`);
      assert.ok(form.blockers.some((b) => /closed/.test(b)), form.blockers.join("; "));
      assert.equal(form.fields.length, 0);
    });
  });
});

describe("Ashby", () => {
  test("open, plan, fill and submit", async () => {
    const ab = createAshbyAdapter({ submitTimeoutMs: 10_000 });
    await withPage(async (page) => {
      const form = await ab.open(page, `${base}/ashby/acme/${ASHBY_ID}/application`);
      assert.deepEqual(form.blockers, []);
      assert.equal(form.hasCaptcha, false);
      assert.equal(form.title, "Robotics Software Co-op");
      assert.equal(form.company, "Acme Robotics");
      const u = (n: string) => `0b0c9a52-5d55-4c1e-9d8c-1d2a7f3e4a${n}`;
      const roles: Record<string, string> = {
        _systemfield_name: "full_name",
        _systemfield_email: "email",
        [u("01")]: "phone",
        _systemfield_resume: "resume",
        [u("02")]: "linkedin",
        _systemfield_location: "location",
        [u("03")]: "work_authorization",
        [u("04")]: "sponsorship",
        [u("05")]: "custom",
        [u("06")]: "school",
        [u("07")]: "grad_date",
        [u("08")]: "degree",
        [u("09")]: "custom",
        [u("10")]: "github",
        _systemfield_eeoc_gender: "eeo_gender",
        _systemfield_eeoc_race: "eeo_race",
        _systemfield_eeoc_veteran_status: "eeo_veteran",
      };
      for (const [key, role] of Object.entries(roles)) assert.equal(field(form, key).role, role, key);
      assert.equal(form.fields.length, Object.keys(roles).length, form.fields.map((f) => f.key).join(", "));
      assert.equal(field(form, u("03")).type, "radio");
      assert.deepEqual(field(form, u("03")).options, ["Yes", "No"]);
      assert.equal(field(form, u("05")).required, true, "required from the _required_ label class");
      assert.equal(field(form, u("02")).required, false);
      assert.equal(field(form, "_systemfield_eeoc_gender").required, false);
      assert.equal(field(form, u("07")).type, "date");
      assert.equal(field(form, u("08")).type, "checkbox");
      assert.equal(field(form, u("09")).description, "Two or three sentences.");

      const { plan, unresolved } = standardFillPlan(form, profile, priv, { resume: RESUME });
      assert.deepEqual(unresolved.map((f) => f.key).sort(), [u("05"), u("09")]);
      assert.deepEqual(plan[u("08")], ["Undergraduate/Bachelors"]);
      assert.equal(plan[u("07")], "2028-05-01");
      assert.equal(plan[u("03")], "Yes");
      assert.equal(plan._systemfield_eeoc_veteran_status, "I decline to self-identify for protected veteran status");
      plan[u("05")] = "1";
      plan[u("09")] = "Acme builds the robots I want to work on.";

      const report = await ab.fill(page, form, plan);
      // Answering "1" reveals a required follow-up; fill reports it instead of letting submit fail later.
      assert.deepEqual(report.failed, [{ key: u("11"), reason: 'a new required question appeared after filling: "Where was your most recent internship or co-op?"' }]);
      const fresh = await ab.describe(page);
      const added = fresh.fields.filter((f) => !form.fields.some((g) => g.key === f.key));
      assert.deepEqual(added.map((f) => [f.key, f.role, f.required]), [[u("11"), "custom", true]]);
      assert.equal(fresh.fields.findIndex((f) => f.key === u("11")), fresh.fields.findIndex((f) => f.key === u("05")) + 1, "fields stay in page order");
      const delta = await ab.fill(page, { ...fresh, fields: added }, { [u("11")]: "Acme Labs" });
      assert.deepEqual(delta, { filled: [u("11")], skipped: [], failed: [] });
      assert.equal(await page.inputValue("#_systemfield_name"), "Jane Husky");
      assert.equal(await page.inputValue(".ashby-application-form-input-autocomplete"), "Boston, MA, USA");
      assert.equal(await page.inputValue(".ashby-application-form-input-date"), "05/01/2028");
      const yes = page.locator(`[data-field-path="${u("03")}"] button[data-option=yes]`);
      assert.equal(await yes.getAttribute("aria-pressed"), "true");
      const no = page.locator(`[data-field-path="${u("04")}"] button[data-option=no]`);
      assert.equal(await no.getAttribute("aria-pressed"), "true");
      assert.equal(await page.isChecked(`[data-field-path="${u("08")}"] input[name="Undergraduate/Bachelors"]`), true);
      assert.equal(await page.isChecked("#s1__systemfield_eeoc_gender-labeled-radio-2"), true);

      const result = await ab.submit(page);
      assert.equal(result.status, "submitted", JSON.stringify(result));
      const post = hits.find((h) => h.method === "POST" && h.path === "/submit/ashby");
      assert.ok(post);
      const body = JSON.parse(post.body) as Record<string, string>;
      assert.equal(body._systemfield_email, "husky.j@example.edu");
      assert.equal(body._systemfield_resume, "Jane_Husky_Resume.pdf");
      assert.equal(body[u("03")], "yes");
      assert.equal(body[u("11")], "Acme Labs");
    });
  });
});


describe("captcha and unknown widgets", () => {
  test("a visible captcha and an unsupported required widget are blockers, and submit refuses", async () => {
    const gh = createGreenhouseAdapter({ apiBase: null, submitTimeoutMs: 3000 });
    await withPage(async (page) => {
      const form = await gh.open(page, `${base}/greenhouse/captchaco/jobs/4000789`);
      assert.equal(form.hasCaptcha, true);
      assert.ok(form.blockers.some((b) => /captcha/i.test(b)), form.blockers.join("; "));
      assert.ok(form.blockers.some((b) => /unsupported required field: "Draw your signature"/.test(b)), form.blockers.join("; "));
      const report = await gh.fill(page, form, { first_name: "Jane", email: "husky.j@example.edu" });
      assert.deepEqual(report.failed, []);
      const result = await gh.submit(page);
      assert.equal(result.status, "blocked");
      assert.match(result.status === "blocked" ? result.detail : "", /captcha/i);
    });
  });
});

describe("other outcomes", () => {
  test("no form, a login wall, and an unconfirmed submit", async () => {
    const gh = createGreenhouseAdapter({ apiBase: null, submitTimeoutMs: 1500 });
    await withPage(async (page) => {
      await page.setContent("<h1>Careers</h1><p>Nothing to apply to here.</p>");
      assert.ok((await gh.describe(page)).blockers.includes("application form not found"));

      await page.setContent('<form><label for="u">Email</label><input id="u" type="email"><label for="p">Password</label><input id="p" type="password"></form>');
      assert.ok((await gh.describe(page)).blockers.includes("login required"));

      await page.setContent(
        '<form id="application-form" onsubmit="return false"><label for="first_name">First Name*</label><input id="first_name" aria-required="true"><button type="submit">Submit application</button></form>',
      );
      const form = await gh.describe(page);
      assert.deepEqual(form.blockers, []);
      assert.deepEqual((await gh.fill(page, form, { first_name: "Jane" })).failed, []);
      const result = await gh.submit(page);
      assert.equal(result.status, "unknown", JSON.stringify(result));
    });
  });
});
