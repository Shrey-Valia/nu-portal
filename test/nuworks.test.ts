import "./helpers.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../src/config/paths.js";
import { JobDetail, JobList } from "../src/nuworks/api-schemas.js";
import { listDate } from "../src/nuworks/live-adapter.js";
import { coverLetterOf, modalityOf, payTextOf, toPosting } from "../src/nuworks/map.js";
import { sameTerm } from "../src/core/filters.js";

const detail = JobDetail.parse(JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "synthetic", "nuworks", "job-detail.json"), "utf8")));

test("a NUworks job detail maps to a Posting", () => {
  const p = toPosting(detail);
  assert.equal(p.title, "Backend Software Co-op");
  assert.equal(p.employer, "Acme Robotics");
  assert.equal(p.term, "2027 - Summer 1");
  assert.ok(sameTerm(p.term!, "Summer 2027"), "NUworks term names match our terms");
  assert.equal(p.modality, "hybrid");
  assert.equal(p.payText, "$25-$28/hr");
  assert.equal(p.coverLetter, "required");
  assert.deepEqual(p.requiredDocs, ["resume", "cover_letter"]);
  assert.equal(p.applyMethod, "nuworks");
  assert.equal(p.deadlineAt, "2026-10-31T23:59:59-04:00");
  assert.equal(p.deadlineAt!.slice(0, 10), listDate("Oct 31, 2026"), "listing and detail dates compare equal");
  assert.equal(p.postedAt, "2026-10-02T18:17:16.000Z");
  assert.deepEqual(p.qualifications, { majors: ["Computer Science"], minGpa: 3, nuworksQualified: false });
});

test("field helpers", () => {
  assert.equal(modalityOf({ ...detail, workplace_type: [{ _label: "Primarily on-site work" }] }), "onsite");
  assert.equal(modalityOf({ ...detail, workplace_type: [{ _label: "Fully Remote" }] }), "remote");
  assert.equal(modalityOf({ ...detail, workplace_type: [] }), "unknown");
  assert.equal(payTextOf({ ...detail, compensation_to: "25" }), "$25/hr");
  assert.equal(payTextOf({ ...detail, compensation_from: null, compensation_to: null }), null);
  assert.equal(coverLetterOf({ ...detail, documents_required: [] }), "optional");
  assert.equal(coverLetterOf({ ...detail, documents_required: [], additional_documents: [] }), "not_accepted");
  assert.equal(toPosting({ ...detail, resume_mode: "other" }).applyMethod, "external");
  assert.equal(listDate("not a date"), null);
});

test("listing pages parse and unknown fields pass through", () => {
  const list = JobList.parse({ perPage: 20, page: 1, total: 1, models: [{ job_id: "a".repeat(32), job_title: "X", name: "Y", deadline: "Oct 16, 2026", extra: 1 }] });
  assert.equal(list.models[0].job_title, "X");
  assert.throws(() => JobList.parse({ perPage: 20, page: 1, models: [] }), "missing total fails loudly");
});
