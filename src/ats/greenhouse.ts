import type { Page } from "playwright";
import { type AdapterOptions, createAdapter, type DescribingAdapter, goto, inPage, type RawField, readComboboxOptions } from "./common.js";
import { applyUrlFor, detectAts } from "./detect.js";

// Greenhouse. Two front ends:
// - job-boards.greenhouse.io (current, React/Remix): <form id="application-form">, labelled inputs with
//   ids (first_name, question_123...), react-select comboboxes (input[role=combobox] + a listbox opened
//   on click), "Attach" buttons over hidden file inputs inside div[role=group][aria-labelledby], an
//   education block (school--0 async search, degree--0, discipline--0, end-month--0, end-year--0), EEO /
//   demographic comboboxes, and an invisible reCAPTCHA Enterprise badge (score-based, not a blocker).
//   Submit goes through JS; success navigates to .../confirmation ("Thank you for applying").
// - boards.greenhouse.io (legacy): <form id="application_form"> with native inputs/selects, labels
//   that wrap their controls, and #submit_app. Old links now redirect to job-boards.
// Company career sites embed the form in iframe#grnhse_iframe (job-boards.greenhouse.io/embed/job_app).

export interface GreenhouseOptions extends AdapterOptions {
  // Base URL of the public job board API, or null to skip it (tests point it at a local server).
  apiBase?: string | null;
  fetchImpl?: typeof fetch;
}

interface GhField {
  name: string;
  type: string;
  values?: { label: string; value: string | number }[];
}
interface GhQuestion {
  label: string;
  description?: string | null;
  required: boolean;
  fields: GhField[];
}
interface GhDemographic {
  id: number;
  label: string;
  required: boolean;
  type: string;
  answer_options?: { label: string }[];
}
interface GhJob {
  title?: string;
  company_name?: string;
  questions?: GhQuestion[];
  location_questions?: GhQuestion[];
  compliance?: { type: string; questions: GhQuestion[] }[] | null;
  demographic_questions?: { questions?: GhDemographic[] } | null;
}
interface GhInfo {
  label: string;
  required: boolean;
  options?: string[];
  multiple: boolean;
  description?: string;
}

export function greenhouseIds(url: string): { board: string; id: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const forBoard = u.searchParams.get("for");
  const token = u.searchParams.get("token") ?? u.searchParams.get("gh_jid");
  if (forBoard && token) return { board: forBoard, id: token };
  const m = u.pathname.match(/\/([A-Za-z0-9_-]+)\/jobs\/(\d+)/);
  if (m) return { board: m[1], id: m[2] };
  return null;
}

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

async function fetchJob(apiBase: string, board: string, id: string, fetchImpl: typeof fetch): Promise<GhJob | null> {
  try {
    const res = await fetchImpl(`${apiBase.replace(/\/$/, "")}/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}?questions=true`, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as GhJob;
  } catch {
    return null;
  }
}

function apiIndex(job: GhJob): Map<string, GhInfo> {
  const map = new Map<string, GhInfo>();
  const add = (q: GhQuestion) => {
    for (const f of q.fields ?? []) {
      if (f.type === "input_hidden") continue;
      map.set(f.name, {
        label: q.label,
        required: q.required,
        options: f.values?.length ? f.values.map((v) => v.label) : undefined,
        multiple: f.type === "multi_value_multi_select",
        description: q.description ? stripHtml(q.description) : undefined,
      });
    }
  };
  (job.questions ?? []).forEach(add);
  (job.location_questions ?? []).forEach(add);
  for (const block of job.compliance ?? []) (block.questions ?? []).forEach(add);
  for (const q of job.demographic_questions?.questions ?? []) {
    map.set(String(q.id), {
      label: q.label,
      required: q.required,
      options: q.answer_options?.map((o) => o.label),
      multiple: q.type === "multi_value_multi_select",
    });
  }
  return map;
}

const normLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const GENERIC_LABEL = /^(veteranstatus|disabilitystatus|race|gender)$/i; // compliance labels without spaces

function applyApi(fields: RawField[], job: GhJob): void {
  const index = apiIndex(job);
  const byLabel = new Map<string, GhInfo>();
  for (const info of index.values()) byLabel.set(normLabel(info.label), info);
  for (const f of fields) {
    const info = index.get(f.key) ?? index.get(f.name) ?? byLabel.get(normLabel(f.label));
    if (!info) continue;
    if (!f.label && !GENERIC_LABEL.test(info.label)) f.label = info.label;
    f.required = f.required || info.required;
    if (!f.options?.length && info.options?.length && f.widget !== "typeahead" && f.widget !== "text" && f.widget !== "file")
      f.options = info.options;
    if (info.multiple && (f.widget === "combobox" || f.widget === "select")) {
      f.multiple = true;
      f.type = "checkbox";
    }
    if (!f.description && info.description) f.description = info.description.slice(0, 500);
  }
}

// On a company career site, find the board token so we can open the hosted form.
async function findBoardToken(page: Page, fetchImpl: typeof fetch, apiBase: string | null, id: string): Promise<string | null> {
  const found: string | null = await page
    .evaluate(
      inPage(() => {
        const urls = [
          ...Array.from(document.querySelectorAll("script[src], iframe[src]")).map((e) => e.getAttribute("src") || ""),
          ...Array.from(document.querySelectorAll("a[href]")).map((e) => e.getAttribute("href") || ""),
        ].filter((u) => /greenhouse\.io/.test(u));
        for (const u of urls) {
          const m = u.match(/[?&](?:for|job_board)=([A-Za-z0-9_-]+)/) || u.match(/greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs\//);
          if (m && m[1] !== "embed") return m[1];
        }
        return null;
      }),
    )
    .catch(() => null);
  if (found) return found;
  if (!apiBase) return null;
  // Guess from the hostname (careers.acme.com -> acme) and confirm with the public API.
  const labels = new URL(page.url()).hostname.split(".").filter((l) => !/^(www|careers?|jobs|apply|com|io|co|org|net|ai)$/.test(l));
  for (const guess of labels.slice(0, 3)) if (await fetchJob(apiBase, guess, id, fetchImpl)) return guess;
  return null;
}

export function createGreenhouseAdapter(opts: GreenhouseOptions = {}): DescribingAdapter {
  const apiBase = opts.apiBase === undefined ? "https://boards-api.greenhouse.io" : opts.apiBase;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return createAdapter(
    {
      kind: "greenhouse",
      matches: (url) => detectAts(url) === "greenhouse",
      formUrl: (url) => applyUrlFor("greenhouse", url),
      ready: ["#application-form", "#application_form", "form.application--form", "text=/no longer open/i"],
      formSelector: "#application-form, #application_form",
      scan: {
        root: ["#application-form", "#application_form"],
        container: ".field-wrapper, .select__container, fieldset, .field, [role=group]",
        questionLabel: "label, legend, .label, .upload-label",
        description: ".description, .helper-text:not(.helper-text--error)",
        exclude: ".iti__search-input, .iti__selected-country, .iti__dropdown-content",
        typeahead: "#candidate-location, input[id^='school--'], #job_application_location",
      },
      submitButtons: [
        "#application-form button[type=submit]",
        "#submit_app",
        "#application_form button[type=submit]",
        "#application_form input[type=submit]",
        "button:has-text('Submit application')",
      ],
      isClosed: (url, text) => /[?&]error=true/.test(url) || /job you are looking for is no longer open/i.test(text),

      async navigate(page, url, timeout) {
        const u = new URL(url);
        if (u.hostname.endsWith("greenhouse.io") || !u.searchParams.has("gh_jid")) return goto(page, url, timeout);
        // Company site with ?gh_jid=: open the embedded Greenhouse form directly.
        const status = await goto(page, url, timeout);
        const src = await page
          .locator("iframe#grnhse_iframe, iframe[src*='greenhouse.io/embed/job_app']")
          .first()
          .getAttribute("src", { timeout: 10_000 })
          .catch(() => null);
        if (src) return goto(page, new URL(src, page.url()).toString(), timeout);
        const id = u.searchParams.get("gh_jid")!;
        const board = await findBoardToken(page, fetchImpl, apiBase, id);
        if (board) return goto(page, `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${encodeURIComponent(id)}`, timeout);
        return status;
      },

      async meta(page) {
        const t = await page.title();
        const m = t.match(/^Job Application for (.+) at (.+)$/);
        if (m) return { title: m[1].trim(), company: m[2].trim() };
        const h1 = await page.locator("h1").first().innerText({ timeout: 1000 }).catch(() => "");
        return { title: h1.trim() || null, company: null };
      },

      async enrich(page, url, fields) {
        const ids = greenhouseIds(page.url()) ?? greenhouseIds(url);
        let out: { company?: string | null; title?: string | null } = {};
        if (apiBase && ids) {
          const job = await fetchJob(apiBase, ids.board, ids.id, fetchImpl);
          if (job) {
            applyApi(fields, job);
            out = { company: job.company_name ?? null, title: job.title ?? null };
          }
        }
        // Dropdowns the API did not describe (EEO, education, phone country): open them and read the options.
        for (const f of fields) {
          if (f.widget !== "combobox" || f.options?.length) continue;
          const read = await readComboboxOptions(page, f.key);
          if (!read) continue;
          f.options = read.options;
          if (read.multiple) {
            f.multiple = true;
            f.type = "checkbox";
          }
        }
        return out;
      },

      async afterFile(page, key) {
        // The React uploader swaps the Attach buttons for the file name (and a remove button).
        const group = page.locator(`[data-nup-key="${key}"]`).locator("xpath=ancestor::*[@role='group'][1]");
        if (!(await group.count())) return; // legacy form: plain file input
        await group
          .locator("text=/remove|\\.(pdf|docx?|txt|rtf)/i")
          .first()
          .waitFor({ timeout: 5000 })
          .catch(() => {});
      },
    },
    opts,
  );
}

export const greenhouse: DescribingAdapter = createGreenhouseAdapter();
