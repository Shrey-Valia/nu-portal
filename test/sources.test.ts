import { TMP } from "./helpers.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT, SOURCES_DIR } from "../src/config/paths.js";
import { parseRepoSlug, pullRepo, repoDir, RepoSlugError } from "../src/sources/git-source.js";
import { countByTerm, dedupeListings, PARSERS, parseRepoDir, parserFor } from "../src/sources/index.js";
import { markdownTableParser, parseMarkdownDir } from "../src/sources/markdown-table.js";
import {
  cleanApplyUrl,
  isCoop,
  listingFingerprint,
  normalizeCategory,
  normalizeSponsorship,
  parseAge,
  parseTerms,
  termsFromHeading,
} from "../src/sources/normalize.js";
import { fromSimplifyEntry, simplifyJsonParser } from "../src/sources/simplify-json.js";
import type { Listing } from "../src/sources/types.js";

const FIXTURES = path.join(ROOT, "test", "fixtures", "synthetic", "sources");
const SIMPLIFY_DIR = path.join(FIXTURES, "simplify");
const MARKDOWN_DIR = path.join(FIXTURES, "markdown");
const REF = new Date("2026-10-06T12:00:00Z");
const byTitle = (ls: Listing[], company: string, title: string) => {
  const found = ls.filter((l) => l.company === company && l.title === title);
  assert.ok(found.length, `missing ${company} / ${title}`);
  return found;
};

test("simplify json: maps fields, skips invisible entries, keeps active as given", () => {
  const ls = simplifyJsonParser.parse(SIMPLIFY_DIR, "acme/Summer2027-Internships");
  assert.equal(ls.length, 6);
  assert.ok(!ls.some((l) => l.company === "Hidden Widgets"));

  const [acme] = byTitle(ls, "Acme Robotics", "Software Engineer Co-op").filter((l) => l.active);
  assert.equal(acme.repo, "acme/Summer2027-Internships");
  assert.equal(acme.sourceId, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(acme.locations, ["Boston, MA", "Remote in USA"]);
  assert.deepEqual(acme.terms, ["Spring 2027"]);
  assert.equal(acme.applyUrl, "https://boards.greenhouse.io/acmerobotics/jobs/1001?gh_jid=1001");
  assert.equal(acme.postedAt, "2026-09-21T14:13:20.000Z");
  assert.equal(acme.sponsorship, "unknown");
  assert.deepEqual(acme.degrees, ["Bachelor's"]);
  assert.equal(acme.category, "Software Engineering");

  const [globex] = byTitle(ls, "Globex Systems", "Data Science Intern");
  assert.equal(globex.active, false);
  assert.deepEqual(globex.terms, ["Summer 2027", "Fall 2027"]);
  assert.equal(globex.applyUrl, "https://jobs.lever.co/globex/abc-123");
  assert.equal(globex.sponsorship, "does_not_offer");
  assert.equal(globex.category, "Data Science, AI & Machine Learning");

  const [initech] = byTitle(ls, "Initech", "Hardware Engineering Intern");
  assert.equal(initech.sponsorship, "us_citizen_only");
  assert.equal(initech.applyUrl, "https://initech.wd1.myworkdayjobs.com/en-US/careers/job/Austin-TX/Hardware-Intern_R-42?jobId=42");
  assert.equal(initech.category, "Hardware Engineering");

  const [umbrella] = byTitle(ls, "Umbrella Analytics", "Quant Research Intern");
  assert.deepEqual(umbrella.terms, []);
  assert.equal(umbrella.sponsorship, "offers");
  assert.equal(umbrella.applyUrl, "https://jobs.ashbyhq.com/umbrella/quant-1#apply");
  assert.equal(umbrella.category, "Quantitative Finance");

  assert.equal(byTitle(ls, "Hooli", "Product Management Intern")[0].category, "Product Management");
});

test("simplify json: older forks with a yearless `season` get the next matching term", () => {
  const l = fromSimplifyEntry(
    {
      company_name: "Contoso",
      title: "SWE Intern",
      season: "Spring/Summer",
      date_posted: Date.UTC(2026, 9, 1) / 1000,
      url: "https://contoso.example.com/j/1",
      active: true,
      locations: ["Seattle, WA"],
      sponsorship: "Other",
    },
    "someone/Summer2027-Internships",
  );
  assert.ok(l);
  assert.deepEqual(l.terms, ["Spring 2027", "Summer 2027"]);
  assert.match(l.sourceId, /^[0-9a-f]{16}$/);
  assert.deepEqual(l.degrees, []);
  assert.equal(l.category, null);
  assert.equal(fromSimplifyEntry({ company_name: "X", title: "Y", is_visible: false }, "a/b"), null);
});

test("markdown: html + pipe tables, ↳ rows, markers, links, locations, terms and ages", () => {
  const ls = parseMarkdownDir(MARKDOWN_DIR, "acme/Summer2026-Internships", REF);
  assert.equal(ls.length, 10);
  assert.ok(!ls.some((l) => l.company === "Ghost Dynamics"), "inactive README is skipped");

  const [swe] = byTitle(ls, "Acme Robotics", "Software Engineer Intern").filter((l) => l.terms[0] === "Summer 2027");
  assert.equal(swe.applyUrl, "https://boards.greenhouse.io/acmerobotics/jobs/1001");
  assert.equal(swe.sourceId, "11111111-2222-4333-8444-555555555555");
  assert.equal(swe.postedAt, "2026-10-06T12:00:00.000Z");
  assert.equal(swe.active, true);
  assert.equal(swe.category, "Software Engineering");

  const [embedded] = byTitle(ls, "Acme Robotics", "Embedded Software Intern");
  assert.equal(embedded.sponsorship, "does_not_offer");
  assert.deepEqual(embedded.locations, ["Boston, MA", "Pittsburgh, PA"]);
  assert.equal(embedded.applyUrl, "https://jobs.lever.co/acmerobotics/emb-7?team=eng");
  assert.equal(embedded.postedAt, "2026-10-03T12:00:00.000Z");
  assert.deepEqual(embedded.terms, ["Summer 2027"]);

  const [globex] = byTitle(ls, "Globex Systems", "Platform Engineering Intern");
  assert.equal(globex.sponsorship, "us_citizen_only");
  assert.deepEqual(globex.locations, ["Austin, TX", "Denver, CO", "Raleigh, NC", "Remote in USA"]);
  assert.equal(globex.applyUrl, "https://globex.wd1.myworkdayjobs.com/en-US/careers/job/Platform-Intern_R-77");
  assert.equal(globex.postedAt, "2026-09-06T12:00:00.000Z");

  const [initech] = byTitle(ls, "Initech", "Machine Learning Intern");
  assert.equal(initech.active, false);
  assert.equal(initech.applyUrl, "");
  assert.deepEqual(initech.degrees, ["Master's", "PhD", "MBA"]);
  assert.match(initech.sourceId, /^[0-9a-f]{16}$/);

  // Second heading switches the term and ends the Software Engineering section.
  const [de] = byTitle(ls, "Umbrella Analytics", "Data Engineering Co-op");
  assert.deepEqual(de.terms, ["Fall 2026"]);
  assert.equal(de.category, null);
  assert.deepEqual(de.locations, ["Cambridge, MA", "Remote"]);
  assert.equal(de.applyUrl, "https://jobs.ashbyhq.com/umbrella/de-123");
  assert.equal(de.postedAt, "2026-09-28T00:00:00.000Z");

  const [sec] = byTitle(ls, "Umbrella Analytics", "Security Co-op");
  assert.equal(sec.applyUrl, "https://jobs.ashbyhq.com/umbrella/sec-456");
  assert.equal(sec.sponsorship, "does_not_offer");

  const [hooli] = byTitle(ls, "Hooli", "Product Design Co-op");
  assert.equal(hooli.active, false);
  assert.equal(hooli.postedAt, "2025-12-15T00:00:00.000Z", "a month-day after the commit date is last year");

  // Off-Season file: Terms column wins over headings; the cutoff table's short header is repaired.
  const [northwind] = byTitle(ls, "Northwind Labs", "Firmware Co-op");
  assert.deepEqual(northwind.terms, ["Winter 2027", "Spring 2027"]);
  assert.equal(northwind.category, "Hardware Engineering");
  const [vandelay] = byTitle(ls, "Vandelay Industries", "Robotics Co-op");
  assert.deepEqual(vandelay.terms, ["Spring 2027"]);
  assert.equal(vandelay.applyUrl, "https://vandelay.example.com/jobs/robo-2");
  assert.equal(vandelay.active, true);
  assert.equal(vandelay.category, "Hardware Engineering");
});

test("parseRepoDir: json wins over README, dedupes by apply URL and merges terms", () => {
  assert.equal(PARSERS[0].name, "simplify-json");
  assert.equal(markdownTableParser.detect(SIMPLIFY_DIR), true);
  assert.equal(parserFor(SIMPLIFY_DIR)?.name, "simplify-json");
  assert.equal(parserFor(MARKDOWN_DIR)?.name, "markdown-table");

  const json = parseRepoDir(SIMPLIFY_DIR, "acme/list");
  assert.equal(json.length, 5);
  assert.ok(!json.some((l) => l.company === "Readme Only Corp"));
  const acme = json.filter((l) => l.company === "Acme Robotics");
  assert.equal(acme.length, 1);
  assert.deepEqual(acme[0].terms, ["Spring 2027", "Summer 2027"]);
  assert.equal(acme[0].active, true);

  const md = parseRepoDir(MARKDOWN_DIR, "acme/list");
  assert.equal(md.length, 9);
  const swe = md.filter((l) => l.applyUrl === "https://boards.greenhouse.io/acmerobotics/jobs/1001");
  assert.equal(swe.length, 1);
  assert.deepEqual(swe[0].terms, ["Summer 2027", "Fall 2026"]);
  assert.equal(new Set(md.map((l) => l.applyUrl).filter(Boolean)).size, md.filter((l) => l.applyUrl).length);

  assert.throws(() => parseRepoDir(mkdtempSync(path.join(TMP, "empty-")), "acme/empty"), /no job list found/);
});

test("dedupe keeps closed rows apart unless fingerprint and terms match", () => {
  const base: Listing = {
    repo: "a/b",
    sourceId: "1",
    company: "Acme",
    title: "Intern",
    locations: ["Boston, MA"],
    terms: ["Fall 2026"],
    applyUrl: "",
    postedAt: null,
    active: false,
    sponsorship: "unknown",
    degrees: [],
    category: null,
    raw: null,
  };
  assert.equal(dedupeListings([base, { ...base, sourceId: "2" }]).length, 1);
  assert.equal(dedupeListings([base, { ...base, terms: ["Spring 2027"] }]).length, 2);
  const counts = countByTerm([base, { ...base, terms: [], applyUrl: "https://x.example.com", active: true }]);
  assert.deepEqual(counts, { "Fall 2026": { total: 1, active: 0 }, "(none)": { total: 1, active: 1 } });
});

test("cleanApplyUrl strips tracking params without re-encoding the rest", () => {
  const cases: [string, string][] = [
    ["https://x.example.com/j?utm_source=Simplify&ref=Simplify", "https://x.example.com/j"],
    ["https://x.example.com/j?gh_jid=5&gh_src=abc&t=1", "https://x.example.com/j?gh_jid=5&t=1"],
    ["https://x.example.com/j?source=Indeed&jobId=9", "https://x.example.com/j?jobId=9"],
    ["https://x.example.com/j?source=careers-page", "https://x.example.com/j?source=careers-page"],
    ["https://x.example.com/j?ref=abc123", "https://x.example.com/j?ref=abc123"],
    ["https://x.example.com/open/?gh_jid=7#/7&utm_source=Simplify&ref=Simplify", "https://x.example.com/open/?gh_jid=7#/7"],
    ["https://x.example.com/x?career%5fns=job&utm_medium=y", "https://x.example.com/x?career%5fns=job"],
    ["https://x.example.com/x?a=1&amp;utm_source=x", "https://x.example.com/x?a=1"],
    ["https://x.example.com/x?jobs=1#jobDetails=5_3", "https://x.example.com/x?jobs=1#jobDetails=5_3"],
    ["  https://x.example.com/x?  ", "https://x.example.com/x"],
    ["", ""],
  ];
  for (const [input, want] of cases) assert.equal(cleanApplyUrl(input), want, input);
});

test("term, category, sponsorship and co-op normalization", () => {
  assert.deepEqual(parseTerms("Summer 2027"), ["Summer 2027"]);
  assert.deepEqual(parseTerms("Winter 2027, Spring 2027"), ["Winter 2027", "Spring 2027"]);
  assert.deepEqual(parseTerms("Spring/Summer 2027"), ["Spring 2027", "Summer 2027"]);
  assert.deepEqual(parseTerms("Spring & Fall 2026 Tech Internships"), ["Spring 2026", "Fall 2026"]);
  assert.deepEqual(parseTerms("Fall '26"), ["Fall 2026"]);
  assert.deepEqual(parseTerms("Autumn 2026 Co-op"), ["Fall 2026"]);
  assert.deepEqual(parseTerms("N/A"), []);
  assert.deepEqual(parseTerms("Falls Church, VA"), []);
  assert.deepEqual(parseTerms("Fall", REF), ["Fall 2027"]);
  assert.deepEqual(parseTerms("Summer", REF), ["Summer 2027"]);
  assert.deepEqual(parseTerms("Spring", new Date("2026-01-01T00:00:00Z")), ["Spring 2026"]);
  assert.deepEqual(parseTerms("Fall"), ["Fall"]);
  assert.deepEqual(termsFromHeading("Summer2026-Internships"), ["Summer 2026"]);
  assert.deepEqual(termsFromHeading("OFFSEASON_README.md"), ["Off-Season"]);
  assert.deepEqual(termsFromHeading("README-Off-Season.md"), ["Off-Season"]);
  assert.deepEqual(termsFromHeading("Don't fall behind"), []);

  assert.equal(normalizeCategory("AI/ML/Data"), "Data Science, AI & Machine Learning");
  assert.equal(normalizeCategory("Software"), "Software Engineering");
  assert.equal(normalizeCategory("Quant"), "Quantitative Finance");
  assert.equal(normalizeCategory("Marketing"), "Marketing");
  assert.equal(normalizeCategory(""), null);
  assert.equal(normalizeCategory(undefined), null);

  assert.equal(normalizeSponsorship("Offers Sponsorship"), "offers");
  assert.equal(normalizeSponsorship("Does Not Offer Sponsorship"), "does_not_offer");
  assert.equal(normalizeSponsorship("U.S. Citizenship is Required"), "us_citizen_only");
  assert.equal(normalizeSponsorship("Other"), "unknown");

  assert.equal(isCoop("Software Engineering Co-op"), true);
  assert.equal(isCoop("Data Coop (Spring)"), true);
  assert.equal(isCoop("Cooperative Robotics Intern"), false);
});

test("parseAge handles relative ages and month-day dates", () => {
  assert.equal(parseAge("0d", REF), "2026-10-06T12:00:00.000Z");
  assert.equal(parseAge("3d", REF), "2026-10-03T12:00:00.000Z");
  assert.equal(parseAge("2w", REF), "2026-09-22T12:00:00.000Z");
  assert.equal(parseAge("1mo", REF), "2026-09-06T12:00:00.000Z");
  assert.equal(parseAge("5h", REF), "2026-10-06T07:00:00.000Z");
  assert.equal(parseAge("Aug 21", REF), "2026-08-21T00:00:00.000Z");
  assert.equal(parseAge("Dec 15", REF), "2025-12-15T00:00:00.000Z");
  assert.equal(parseAge("Sep 1, 2025", REF), "2025-09-01T00:00:00.000Z");
  assert.equal(parseAge("2026-08-21", REF), "2026-08-21T00:00:00.000Z");
  assert.equal(parseAge("🔒", REF), null);
  assert.equal(parseAge("", REF), null);
});

test("listingFingerprint is company|title|first location, lowercased without punctuation", () => {
  assert.equal(
    listingFingerprint({ company: "Acme Robotics, Inc.", title: "Software Engineer Co-op (Spring 2027)", locations: ["Boston, MA", "NYC"] }),
    "acme robotics inc|software engineer coop spring 2027|boston ma",
  );
  assert.equal(listingFingerprint({ company: "Müller  GmbH", title: "Intern", locations: ["Würselen, Germany"] }), "muller gmbh|intern|wurselen germany");
  assert.equal(listingFingerprint({ company: "Acme", title: "Intern", locations: [] }), "acme|intern|");
});

test("repo slugs are validated strictly and map inside SOURCES_DIR", async () => {
  for (const ok of [
    "SimplifyJobs/Summer2026-Internships",
    "https://github.com/SimplifyJobs/Summer2026-Internships",
    "https://github.com/SimplifyJobs/Summer2026-Internships.git",
    "https://github.com/SimplifyJobs/Summer2026-Internships/",
    "  SimplifyJobs/Summer2026-Internships.git ",
  ]) {
    assert.equal(parseRepoSlug(ok).repo, "SimplifyJobs/Summer2026-Internships", ok);
  }
  assert.equal(parseRepoSlug("a-b/c.d_e").repo, "a-b/c.d_e");

  for (const bad of [
    "",
    "a",
    "a/b/c",
    "http://github.com/a/b",
    "https://gitlab.com/a/b",
    "https://github.com.evil.example/a/b",
    "https://user@github.com/a/b",
    "git@github.com:a/b.git",
    "file:///etc/passwd",
    "https://github.com/a/b/tree/main",
    "https://github.com/a/b?tab=readme",
    "https://github.com/a/b/../../c",
    "../etc/passwd",
    "a/..",
    "a/.",
    "-a/b",
    "a/-b",
    "a--b/c",
    "a/b c",
    "a/b;rm -rf ~",
    "a/$(id)",
  ]) {
    assert.throws(() => parseRepoSlug(bad), RepoSlugError, bad);
  }

  assert.ok(SOURCES_DIR.startsWith(TMP));
  assert.equal(repoDir("https://github.com/SimplifyJobs/Summer2026-Internships"), path.join(SOURCES_DIR, "SimplifyJobs__Summer2026-Internships"));
  // Rejected before git ever runs, so no network.
  await assert.rejects(pullRepo("https://evil.example/a/b"), RepoSlugError);
});
