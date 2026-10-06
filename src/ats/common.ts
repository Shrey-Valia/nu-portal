import path from "node:path";
import type { Locator, Page } from "playwright";
import { captchaDom, type CaptchaState, type PageSnapshot, type RawField, type ScanConfig, type ScanResult, scanDom, snapshotDom } from "./inpage.js";
import type { ApplyForm, AtsAdapter, AtsKind, FieldRole, FieldType, FieldValue, FillPlan, FillReport, FormField, SubmitResult } from "./types.js";

export type { CaptchaState, RawField, ScanConfig, ScanResult, Widget } from "./inpage.js";

// ---------------------------------------------------------------------------
// Pacing and options

// Human-like pause between actions. Callers decide the pacing (see core/util humanDelay).
export type Delay = () => Promise<void>;
export const noDelay: Delay = async () => {};

export interface AdapterOptions {
  delay?: Delay; // awaited before each field and before clicking submit
  navTimeoutMs?: number; // page load (default 45s)
  readyTimeoutMs?: number; // wait for the form to render (default 20s)
  submitTimeoutMs?: number; // wait for a confirmation after submit (default 20s)
}

// ---------------------------------------------------------------------------
// Running code in the page

// tsx (esbuild keepNames) rewrites nested functions to call a `__name` helper that does not exist in
// the browser. Re-wrapping the source with a local no-op `__name` keeps page functions in plain TS.
export function inPage<F extends (...args: never[]) => unknown>(fn: F): F {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("a", "b", `const __name = (f) => f; return (${fn.toString()})(a, b);`) as F;
}

export function scanForm(page: Page, cfg: ScanConfig): Promise<ScanResult> {
  return page.evaluate(inPage(scanDom), cfg);
}

export async function detectCaptcha(page: Page): Promise<CaptchaState> {
  try {
    return await page.evaluate(inPage(captchaDom));
  } catch {
    return { visible: false, passive: false, kind: null };
  }
}

export function snapshot(page: Page, cfg: { formSelector: string; successSelector?: string }): Promise<PageSnapshot> {
  return page.evaluate(inPage(snapshotDom), { ...cfg, confirmText: CONFIRM_TEXT.source });
}

const attrSel = (name: string, value: string) => `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
export const keyLocator = (page: Page, key: string): Locator => page.locator(attrSel("data-nup-key", key)).first();
export const groupLocator = (page: Page, key: string): Locator => page.locator(attrSel("data-nup-group", key));

const msg = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));

// ---------------------------------------------------------------------------
// Field roles

const QUESTION_START = /^(are|do|does|did|will|would|have|has|had|can|could|is|was|were|should|may)\b/i;
const CHOICE: FieldType[] = ["select", "radio", "checkbox"];
const TEXTY: FieldType[] = ["text", "email", "tel", "url", "number", "textarea", "date"];

interface Rule {
  role: FieldRole;
  re: RegExp;
  not?: RegExp;
  types?: FieldType[]; // allowed field types (default: any)
  noQuestion?: boolean; // skip when the label is a yes/no question ("Are you currently located in...?")
  maxWords?: number;
}

const ID_TYPES: FieldType[] = ["text", "email", "tel", "url", "number", "select", "date"];

const RULES: Rule[] = [
  { role: "resume", re: /resum|\bcv\b|curriculum vitae/i, types: ["file"] },
  { role: "cover_letter", re: /cover\s*letter|motivation letter/i, types: ["file", "textarea"] },
  // Voluntary self-identification. Checked before work questions: "Are you Hispanic/Latino?" is EEO.
  { role: "eeo_hispanic", re: /hispanic|latin[oax]/i, types: [...CHOICE, "text"] },
  { role: "eeo_race", re: /\brace\b|ethnicit/i, not: /orientation/i, types: [...CHOICE, "text"] },
  { role: "eeo_veteran", re: /veteran|military (status|service)/i, types: [...CHOICE, "text"] },
  { role: "eeo_disability", re: /disabilit/i, not: /accommodat|adjustment/i, types: [...CHOICE, "text"] },
  { role: "eeo_gender", re: /\bgender\b|\bsex\b/i, not: /orientation|transgender|pronoun|sexual/i, types: [...CHOICE, "text"] },
  // "Authorized to work without sponsorship?" is an authorization question (answered Yes only if both hold).
  { role: "work_authorization", re: /authori[sz]ed\b.*\bwithout\b.*sponsor|without\b.*sponsor.*\bauthori[sz]ed/i },
  { role: "sponsorship", re: /sponsor|\bvisa\b|h-?1b|immigration (support|status)/i },
  {
    role: "work_authorization",
    re: /authori[sz](ed|ation) to work|work authori[sz]ation|legally (authori[sz]ed|eligible|permitted|able) to work|eligible to work|right to work|legally work|lawfully work|work lawfully|permitted to work|authori[sz]ed to work lawfully/i,
  },
  { role: "date_of_birth", re: /date of birth|birth ?date|\bd\.?o\.?b\b/i, types: [...TEXTY, "select"] },
  { role: "gpa", re: /\bgpa\b|grade point/i, types: [...TEXTY, "select", "radio"] },
  {
    role: "grad_date",
    re: /graduat|expected (completion|grad)|completion date|end[- ]?(date|month|year)|class of\b/i,
    noQuestion: true,
    types: [...TEXTY, "select", "radio"],
  },
  {
    role: "start_date",
    re: /\bstart(ing)? date\b|available to start|earliest (start|availability)|when (can|could) you start|availability date|date available/i,
    not: /month|year/i,
    noQuestion: true,
    types: TEXTY,
  },
  { role: "school", re: /\bschool\b|universit|college|institution|alma mater/i, not: /high school/i, noQuestion: true, types: [...ID_TYPES, "radio"] },
  { role: "degree", re: /\bdegree\b|level of education|education level|highest (level of )?education/i, noQuestion: true, types: [...ID_TYPES, "radio", "checkbox"] },
  { role: "discipline", re: /\bmajor\b|discipline|field of study|area of study|concentration|program of study/i, noQuestion: true, types: [...ID_TYPES, "radio", "checkbox"] },
  {
    role: "preferred_name",
    re: /preferred (first )?name|nick ?name|name you('d| would)? (like|prefer)|prefer(red)? to be called|goes by/i,
    noQuestion: true,
    types: ID_TYPES,
  },
  { role: "first_name", re: /first[\s_-]*name|given[\s_-]*name|\bfname\b|forename/i, noQuestion: true, types: ID_TYPES },
  { role: "last_name", re: /last[\s_-]*name|surname|family[\s_-]*name|\blname\b/i, noQuestion: true, types: ID_TYPES },
  {
    role: "full_name",
    re: /^(your |full |legal |candidate'?s? |applicant'?s? )*(full )?name( \(.*\))?$|\bfull[\s_-]*name\b/i,
    not: /if different|company|employer|school|reference|referr|recruiter|manager|emergency/i,
    noQuestion: true,
    types: ID_TYPES,
  },
  { role: "email", re: /e-?mail/i, types: ["text", "email"] },
  { role: "phone", re: /phone|mobile|\bcell\b|telephone/i, not: /type|extension|\bext\b/i, types: ["text", "tel", "number"] },
  { role: "linkedin", re: /linked\s*in/i, types: ["text", "url", "textarea"] },
  { role: "github", re: /git\s*hub/i, types: ["text", "url", "textarea"] },
  {
    role: "website",
    re: /website|portfolio|personal (site|url|page|link)|\bblog\b|other (url|link|site)|\burl\b/i,
    not: /twitter|facebook|instagram|tiktok|company website/i,
    types: ["text", "url", "textarea"],
  },
  {
    role: "location",
    re: /\blocation\b|\bcity\b|where (are you|do you) (currently )?(live|located|based|reside)|current(ly)? (located|based|residing)|place of residence/i,
    not: /office|prefer|relocat|work location|willing|hybrid|remote/i,
    noQuestion: true,
    types: ["text", "select"],
  },
  {
    role: "address",
    re: /\bcountry\b/i,
    not: /countries|work in|working in|anticipate|citizen|nationality|code$/i,
    noQuestion: true,
    types: ["text", "select", "radio"],
  },
  {
    role: "address",
    re: /street|address|zip|postal|post ?code|^state\b|\bstate( \/ province)?$|province|^county$/i,
    noQuestion: true,
    types: ["text", "select"],
    maxWords: 6,
  },
];

function normalizeName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-[\].]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function runRules(text: string, type: FieldType, isLabel: boolean): FieldRole | null {
  const t = text.trim();
  if (!t) return null;
  const question = isLabel && QUESTION_START.test(t);
  const words = t.split(/\s+/).length;
  for (const r of RULES) {
    if (r.types && !r.types.includes(type)) continue;
    if (r.noQuestion && question) continue;
    if (r.maxWords && words > r.maxWords) continue;
    if (!r.re.test(t)) continue;
    if (r.not?.test(t)) continue;
    return r.role;
  }
  return null;
}

// What a field is for, from its visible label, its name/id and its type. "custom" when unsure.
export function classifyRole(label: string, name: string, type: FieldType): FieldRole {
  const byLabel = runRules(label, type, true);
  if (byLabel) return byLabel;
  // Fall back to the input name (first_name, urls[LinkedIn], _systemfield_eeoc_gender), but never for
  // generated ids like question_123 or uuids, which never match anyway.
  const byName = runRules(normalizeName(name), type, false);
  return byName ?? "custom";
}

// ---------------------------------------------------------------------------
// Option matching

export function normalizeOption(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+\+\d[\d\s-]*$/, "") // trailing phone dial code: "United States +1"
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?:;,]+$/, "");
}

const isBoundary = (s: string, i: number) => i < 0 || i >= s.length || !/[a-z0-9]/i.test(s[i]);
function containsWord(hay: string, needle: string): boolean {
  if (!needle) return false;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    if (isBoundary(hay, i - 1) && isBoundary(hay, i + needle.length)) return true;
    i = hay.indexOf(needle, i + 1);
  }
  return false;
}

function matchOne(options: readonly string[], want: string): string | null {
  if (options.includes(want)) return want;
  const w = normalizeOption(want);
  if (!w) return null;
  const norm = options.map(normalizeOption);
  const pickUnique = (pred: (n: string) => boolean): string | null | undefined => {
    const hits = options.filter((_, i) => pred(norm[i]));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return new Set(hits.map(normalizeOption)).size === 1 ? hits[0] : null; // ambiguous
    return undefined;
  };
  const eq = pickUnique((n) => n === w);
  if (eq !== undefined) return eq;
  const starts = pickUnique((n) => n.startsWith(w) && isBoundary(n, w.length));
  if (starts !== undefined) return starts;
  if (w.length <= 3) return null; // "Yes"/"No" only match exactly or as the leading word
  const contains = pickUnique((n) => containsWord(n, w) || (n.length >= 4 && containsWord(w, n)));
  return contains ?? null;
}

// Best option for a desired value: exact > case-insensitive > leading words > whole-word contains.
// Several candidate spellings may be given; the first that matches wins. Null when nothing matches
// or the match is ambiguous.
export function matchOption(options: readonly string[], desired: string | readonly string[]): string | null {
  const wants = (typeof desired === "string" ? [desired] : desired).filter((w) => w && w.trim());
  for (const want of wants) {
    const m = matchOne(options, want);
    if (m !== null) return m;
  }
  return null;
}

export const DECLINE_RE =
  /decline|prefer not|don'?t wish|do not wish|not wish to|rather not|choose not|wish not|not to (say|answer|disclose|self|identify)|i don'?t want to|do not want to|not (specified|disclosed)|undisclosed/i;

export function pickDecline(options: readonly string[]): string | null {
  const hits = options.filter((o) => DECLINE_RE.test(o));
  return hits[0] ?? null;
}

// GPA option ranges like "3.5 - 4.0" or "3.50-3.74".
export function matchNumericRange(options: readonly string[], value: number): string | null {
  const hits = options.filter((o) => {
    const m = o.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/);
    if (!m) return false;
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return value >= Math.min(lo, hi) && value <= Math.max(lo, hi);
  });
  return hits.length === 1 ? hits[0] : null;
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export function stateName(abbrOrName: string): string | null {
  const s = abbrOrName.trim();
  return US_STATES[s.toUpperCase()] ?? (Object.values(US_STATES).find((n) => n.toLowerCase() === s.toLowerCase()) || null);
}

// Location suggestions ("Boston, Massachusetts, United States") for a profile city ("Boston, MA").
export function matchLocation(options: readonly string[], desired: string): string | null {
  const direct = matchOption(options, desired);
  if (direct) return direct;
  const [city, region] = desired.split(",").map((s) => s.trim());
  const c = normalizeOption(city ?? "");
  if (!c) return null;
  const cands = options.filter((o) => {
    const n = normalizeOption(o);
    return n.startsWith(c) && isBoundary(n, c.length);
  });
  if (cands.length <= 1) return cands[0] ?? null;
  if (region) {
    const names = [normalizeOption(region), normalizeOption(stateName(region) ?? "")].filter(Boolean);
    const r = cands.find((o) => names.some((nm) => containsWord(normalizeOption(o), nm)));
    if (r) return r;
  }
  return cands[0];
}

// ---------------------------------------------------------------------------
// Dates

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export const monthName = (m: number) => MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1);

export interface DateParts {
  y: number;
  m: number;
  d: number;
}

// "May 2028", "Spring 2028", "2028-05-15", "05/15/2028", "05/2028", "2028".
export function parseLooseDate(s: string): DateParts | null {
  const t = s.trim().toLowerCase();
  let m = t.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (m) return { y: +m[1], m: +m[2], d: m[3] ? +m[3] : 1 };
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { y: +m[3], m: +m[1], d: +m[2] };
  m = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return { y: +m[2], m: +m[1], d: 1 };
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(?:(\d{1,2}),?\s+)?(\d{4})\b/);
  if (m) return { y: +m[3], m: MONTHS.findIndex((x) => x.startsWith(m![1].slice(0, 3))) + 1, d: m[2] ? +m[2] : 1 };
  m = t.match(/\b(spring|summer|fall|autumn|winter)\s+(\d{4})\b/);
  if (m) return { y: +m[2], m: { spring: 5, summer: 8, fall: 12, autumn: 12, winter: 12 }[m[1] as "spring"], d: 1 };
  m = t.match(/^(\d{4})$/);
  if (m) return { y: +m[1], m: 5, d: 1 };
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (p: DateParts) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
export const usDate = (p: DateParts) => `${pad(p.m)}/${pad(p.d)}/${p.y}`;

// ---------------------------------------------------------------------------
// Page inspection used by open()

export const CLOSED_RE =
  /no longer (open|available|accepting)|job (you('| a)re looking for )?(was )?not found|couldn'?t find anything here|might have closed|posting (has been |is )?closed|position (has been|is) (filled|closed)|this (job|position|posting) (is|has been) (closed|removed|filled)|page not found|\b404\b/i;
export const LOGIN_RE = /sign in to apply|log ?in to apply|create an account to (continue|apply)|please (sign|log) in to continue/i;
export const CONFIRM_TEXT =
  /thank(s| you),? for (applying|your (application|interest|submission))|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application|your application (has been|was) (submitted|received|sent)/;
export const CONFIRM_URL = /\/(confirmation|confirm|thanks|thank-you|thank_you|thankyou|success|submitted)(\/|$)/i;

export async function goto(page: Page, url: string, timeout: number): Promise<number | null> {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  return resp?.status() ?? null;
}

// React forms keep rendering after the root appears (demographic sections, consent boxes): wait until
// the number of form controls stops changing.
export async function settle(page: Page, maxMs = 6000): Promise<void> {
  const count = () => page.locator("input, select, textarea, [role=combobox]").count().catch(() => -1);
  const deadline = Date.now() + maxMs;
  let last = await count();
  let stable = 0;
  while (Date.now() < deadline && stable < 2) {
    await page.waitForTimeout(300);
    const n = await count();
    stable = n === last ? stable + 1 : 0;
    last = n;
  }
}

export async function waitForAny(page: Page, selectors: string[], timeout: number): Promise<boolean> {
  if (!selectors.length) return true;
  try {
    const loc = selectors.slice(1).reduce((acc, sel) => acc.or(page.locator(sel)), page.locator(selectors[0]));
    await loc.first().waitFor({ state: "attached", timeout });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Combobox helpers (react-select and ARIA listboxes)

async function visibleOptions(page: Page, input: Locator, resultsSelector?: string): Promise<Locator> {
  if (resultsSelector) return page.locator(resultsSelector).locator("visible=true");
  const controls = (await input.getAttribute("aria-controls").catch(() => null)) || (await input.getAttribute("aria-owns").catch(() => null));
  if (controls) {
    const lb = page.locator(attrSel("id", controls));
    if (await lb.count()) return lb.locator('[role="option"]');
  }
  return page.locator('[role="listbox"] [role="option"]').locator("visible=true");
}

async function waitForOptions(page: Page, input: Locator, timeout: number, resultsSelector?: string): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const opts = await visibleOptions(page, input, resultsSelector);
    if ((await opts.count()) > 0) return opts;
    await page.waitForTimeout(120);
  }
  return null;
}

const texts = async (opts: Locator) => (await opts.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());

// Open a dropdown, read its options, close it. Read-only.
export async function readComboboxOptions(page: Page, key: string): Promise<{ options: string[]; multiple: boolean } | null> {
  const input = keyLocator(page, key);
  try {
    await input.scrollIntoViewIfNeeded({ timeout: 3000 });
    await input.click({ timeout: 3000 });
    const opts = await waitForOptions(page, input, 2500);
    if (!opts) {
      await page.keyboard.press("Escape");
      return null;
    }
    const list = await texts(opts);
    const lb = opts.first().locator("xpath=ancestor::*[@role='listbox'][1]");
    const multiple = (await lb.getAttribute("aria-multiselectable").catch(() => null)) === "true";
    await page.keyboard.press("Escape");
    return { options: list, multiple };
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return null;
  }
}

async function comboboxShows(input: Locator, choice: string): Promise<boolean> {
  return input.evaluate(
    inPage((el: Element, want: string) => {
      const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const box =
        el.closest('[class*="control"]') || el.closest('[class*="container"]') || el.parentElement?.parentElement?.parentElement || el;
      const vals = box.querySelectorAll('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]');
      if (vals.length && Array.from(vals).some((v) => norm(v.textContent).includes(norm(want).slice(0, 12)))) return true;
      if ((el as HTMLInputElement).value && norm((el as HTMLInputElement).value).includes(norm(want).slice(0, 12))) return true;
      return norm((box as HTMLElement).innerText).includes(norm(want).slice(0, 12));
    }),
    choice,
  );
}

async function fillCombobox(page: Page, key: string, values: string[], known?: string[]): Promise<void> {
  const input = keyLocator(page, key);
  for (const value of values) {
    await input.scrollIntoViewIfNeeded();
    await input.click();
    let opts = await waitForOptions(page, input, 3000);
    let list = opts ? await texts(opts) : [];
    let choice = matchOption(list, value);
    if (!choice && (list.length > 25 || !opts)) {
      // Long or lazy lists: type to filter.
      await input.pressSequentially(value.slice(0, 40), { delay: 25 });
      opts = await waitForOptions(page, input, 4000);
      list = opts ? await texts(opts) : [];
      choice = matchOption(list, value) ?? (known ? matchOption(list, matchOption(known, value) ?? "") : null);
    }
    if (!opts || !choice) {
      await page.keyboard.press("Escape").catch(() => {});
      throw new Error(`no option matches "${value}"`);
    }
    await opts.nth(list.indexOf(choice)).click();
    if (!(await comboboxShows(input, choice))) throw new Error(`selection "${choice}" did not stick`);
  }
  await page.keyboard.press("Escape").catch(() => {});
}

async function fillTypeahead(
  page: Page,
  key: string,
  value: string,
  opts: { location: boolean; requireSelection: boolean; resultsSelector?: string },
): Promise<void> {
  const input = keyLocator(page, key);
  const attempt = async (query: string) => {
    await input.scrollIntoViewIfNeeded();
    await input.click();
    await input.fill("");
    await input.pressSequentially(query, { delay: 35 });
    return waitForOptions(page, input, 8000, opts.resultsSelector);
  };
  let found = await attempt(value);
  if (!found && opts.location && value.includes(",")) found = await attempt(value.split(",")[0].trim());
  if (!found) {
    if (!opts.requireSelection && (await input.inputValue().catch(() => ""))) return; // free text is accepted
    throw new Error(`no suggestions appeared for "${value}"`);
  }
  const list = await texts(found);
  const choice = opts.location ? matchLocation(list, value) : matchOption(list, value);
  if (!choice) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(`no suggestion matches "${value}" (saw: ${list.slice(0, 5).join(" | ")})`);
  }
  await found.nth(list.indexOf(choice)).click();
  if (opts.requireSelection && !(await comboboxShows(input, choice))) throw new Error(`selection "${choice}" did not stick`);
}

// ---------------------------------------------------------------------------
// Generic fillers

const digits = (s: string) => s.replace(/\D/g, "");

async function fillText(loc: Locator, value: string, type: FieldType): Promise<void> {
  await loc.scrollIntoViewIfNeeded();
  await loc.fill(value);
  const got = await loc.inputValue();
  if (got === value || got.trim() === value.trim()) return;
  if (type === "tel" || /^[+\d\s().-]+$/.test(value)) {
    const a = digits(got);
    const b = digits(value);
    if (a && (a.endsWith(b) || b.endsWith(a))) return;
  }
  throw new Error(`value did not stick (field shows "${got.slice(0, 40)}")`);
}

async function fillNativeSelect(loc: Locator, value: string | string[]): Promise<void> {
  const list: string[] = await loc.evaluate(
    inPage((el: Element) => Array.from((el as HTMLSelectElement).options).map((o) => o.text.replace(/\s+/g, " ").trim())),
  );
  const wants = Array.isArray(value) ? value : [value];
  const indexes = wants.map((w) => {
    const choice = matchOption(list.filter(Boolean), w);
    if (!choice) throw new Error(`no option matches "${w}"`);
    return list.indexOf(choice);
  });
  await loc.selectOption(indexes.map((index) => ({ index })));
}

async function setChecked(page: Page, inp: Locator, on: boolean): Promise<void> {
  if ((await inp.isChecked()) === on) return;
  try {
    await inp.setChecked(on, { timeout: 3000 });
  } catch {
    // Styled inputs are often hidden behind their label.
    const id = await inp.getAttribute("id");
    const label = id ? page.locator(attrSel("for", id)).first() : inp.locator("xpath=ancestor::label[1]");
    await label.click({ timeout: 3000 });
  }
  if ((await inp.isChecked()) !== on) throw new Error("checkbox state did not change");
}

async function groupOptions(page: Page, key: string): Promise<{ group: Locator; list: string[] }> {
  const group = groupLocator(page, key);
  const n = await group.count();
  const list: string[] = [];
  for (let i = 0; i < n; i++) list.push((await group.nth(i).getAttribute("data-nup-option")) ?? "");
  return { group, list };
}

const TRUTHY = /^(yes|y|true|checked|on|1|agree|i agree|accept|acknowledge)$/i;

async function fillChoiceGroup(page: Page, raw: RawField, value: FieldValue): Promise<void> {
  const { group, list } = await groupOptions(page, raw.key);
  if (!list.length) throw new Error("options not found on page");
  const wants = Array.isArray(value) ? value : [String(value)];
  if (raw.widget === "radio" || raw.widget === "yesno") {
    const choice = matchOption(list, wants[0]);
    if (!choice) throw new Error(`no option matches "${wants[0]}"`);
    const el = group.nth(list.indexOf(choice));
    await el.scrollIntoViewIfNeeded();
    if (raw.widget === "yesno") {
      // Never click something that would submit a form (a <button> inside a <form> defaults to submit).
      const submits = await el.evaluate(inPage((b: Element) => (b as HTMLButtonElement).type === "submit" && !!(b as HTMLButtonElement).form));
      if (submits) throw new Error("yes/no option is a submit button; refusing to click");
      await el.click();
      for (let i = 0; i < 10 && (await el.getAttribute("aria-pressed")) === "false"; i++) await page.waitForTimeout(100);
      if ((await el.getAttribute("aria-pressed")) === "false") throw new Error(`"${choice}" did not register`);
    } else await setChecked(page, el, true);
    return;
  }
  // Checkboxes: one consent box, or a multi-select group.
  let targets: Set<number>;
  if (list.length === 1 && wants.length === 1 && (TRUTHY.test(wants[0].trim()) || matchOption(list, wants[0]))) targets = new Set([0]);
  else if (list.length === 1 && wants.length === 1 && /^(no|false|unchecked|off|0)$/i.test(wants[0].trim())) targets = new Set();
  else {
    targets = new Set(
      wants.map((w) => {
        const c = matchOption(list, w);
        if (!c) throw new Error(`no option matches "${w}"`);
        return list.indexOf(c);
      }),
    );
  }
  for (let i = 0; i < list.length; i++) await setChecked(page, group.nth(i), targets.has(i));
}

async function fillFile(page: Page, loc: Locator, file: string): Promise<void> {
  await loc.setInputFiles(file);
  const count = await loc.evaluate(inPage((el: Element) => (el as HTMLInputElement).files?.length ?? 0)).catch(() => 0);
  if (count > 0) return;
  // Some React uploaders read the file and reset the input; look for the file name instead.
  try {
    await page.getByText(path.basename(file), { exact: false }).first().waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    throw new Error("upload was not accepted");
  }
}

async function fillDate(loc: Locator, value: string, widget: "date" | "datepicker" | "text"): Promise<void> {
  const p = parseLooseDate(value);
  if (!p) throw new Error(`cannot read date "${value}"`);
  if (widget === "date") {
    await loc.fill(isoDate(p));
  } else {
    // Type the date and close the picker. No Enter: inside a <form> it could submit.
    await loc.scrollIntoViewIfNeeded();
    await loc.click();
    await loc.fill(usDate(p));
    await loc.press("Escape").catch(() => {});
    await loc.blur().catch(() => {});
  }
  if (!(await loc.inputValue())) throw new Error("date did not stick");
}

// ---------------------------------------------------------------------------
// Adapter skeleton shared by Greenhouse, Lever and Ashby

export interface AdapterSpec {
  kind: AtsKind;
  matches(url: string): boolean;
  formUrl(url: string): string;
  scan: ScanConfig;
  ready: string[]; // selectors meaning "the form (or a closed notice) has rendered"
  formSelector: string;
  submitButtons: string[];
  successSelector?: string;
  resultsSelector?: string; // typeahead suggestions that are not role=option
  isClosed?(url: string, text: string): boolean;
  navigate?(page: Page, url: string, timeout: number): Promise<number | null>;
  prepare?(page: Page): Promise<void>;
  meta?(page: Page): Promise<{ company: string | null; title: string | null }>;
  // Improve labels/options/required flags in place; may return company/title from an API.
  enrich?(page: Page, url: string, fields: RawField[]): Promise<{ company?: string | null; title?: string | null } | void>;
  afterFile?(page: Page, key: string): Promise<void>;
}

function toFormField(raw: RawField): FormField {
  const f: FormField = {
    key: raw.key,
    label: raw.label,
    type: raw.type,
    role: classifyRole(raw.label, raw.name, raw.type),
    required: raw.required,
  };
  if (raw.options?.length) f.options = raw.options;
  if (raw.maxLength) f.maxLength = raw.maxLength;
  if (raw.description) f.description = raw.description;
  return f;
}

// AtsAdapter plus describe(): re-read the form on the current page without navigating, e.g. after
// fill() reports that a follow-up question appeared. Fill only the new fields afterwards:
//   const fresh = await adapter.describe(page);
//   const added = fresh.fields.filter((f) => !form.fields.some((g) => g.key === f.key));
//   await adapter.fill(page, { ...fresh, fields: added }, answersForAdded);
export interface DescribingAdapter extends AtsAdapter {
  describe(page: Page, url?: string): Promise<ApplyForm>;
}

export function createAdapter(spec: AdapterSpec, opts: AdapterOptions = {}): DescribingAdapter {
  const delay = opts.delay ?? noDelay;
  const navTimeout = opts.navTimeoutMs ?? 45_000;
  const readyTimeout = opts.readyTimeoutMs ?? 20_000;
  const submitTimeout = opts.submitTimeoutMs ?? 20_000;

  // Read-only description of the form on the current page.
  async function describe(page: Page, url = page.url(), status: number | null = null): Promise<ApplyForm> {
    const form: ApplyForm = { ats: spec.kind, url: page.url(), company: null, title: null, fields: [], hasCaptcha: false, blockers: [] };
    const snap = await snapshot(page, { formSelector: spec.formSelector, successSelector: spec.successSelector });
    const captcha = await detectCaptcha(page);
    const scan = await scanForm(page, spec.scan);
    const meta = (await spec.meta?.(page).catch(() => null)) ?? { company: null, title: null };
    const extra = (await spec.enrich?.(page, url, scan.fields).catch(() => undefined)) || {};
    form.company = extra.company ?? meta.company;
    form.title = extra.title ?? meta.title;
    form.fields = scan.fields.map(toFormField);
    form.hasCaptcha = captcha.visible;

    const noForm = !scan.formFound || form.fields.length === 0;
    const closed =
      status === 404 || status === 410 || !!spec.isClosed?.(page.url(), snap.text) || (noForm && CLOSED_RE.test(snap.text));
    if (closed) form.blockers.push("posting is closed or no longer exists");
    if (snap.passwordVisible || LOGIN_RE.test(snap.text)) form.blockers.push("login required");
    if (captcha.visible) form.blockers.push(`captcha present (${captcha.kind})`);
    if (noForm && !closed) form.blockers.push("application form not found");
    for (const label of scan.unknownRequired) form.blockers.push(`unsupported required field: "${label}"`);
    return form;
  }

  return {
    kind: spec.kind,
    matches: spec.matches,
    describe: (page, url) => describe(page, url),

    async open(page, url) {
      const target = spec.formUrl(url);
      let status: number | null;
      try {
        status = spec.navigate ? await spec.navigate(page, target, navTimeout) : await goto(page, target, navTimeout);
      } catch (err) {
        return { ats: spec.kind, url: target, company: null, title: null, fields: [], hasCaptcha: false, blockers: [`could not load the posting: ${msg(err)}`] };
      }
      if (status === null || status < 400) {
        await waitForAny(page, spec.ready, readyTimeout);
        await settle(page);
      }
      await spec.prepare?.(page).catch(() => {});
      return describe(page, url, status);
    },

    async fill(page, form, plan) {
      const report: FillReport = { filled: [], skipped: [], failed: [] };
      const scan = await scanForm(page, spec.scan);
      const byKey = new Map(scan.fields.map((f) => [f.key, f]));
      const known = new Set(form.fields.map((f) => f.key));
      for (const key of Object.keys(plan)) if (!known.has(key)) report.failed.push({ key, reason: "not a field of this form" });

      const empty = (v: FieldValue | undefined) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
      // Uploads first: Lever and Ashby parse the resume and may prefill fields we then overwrite.
      const ordered = [...form.fields].sort((a, b) => Number(b.type === "file") - Number(a.type === "file"));
      for (const field of ordered) {
        const value = plan[field.key];
        if (empty(value)) {
          if (field.required) report.failed.push({ key: field.key, reason: "required field has no value" });
          else report.skipped.push({ key: field.key, reason: "no value" });
          continue;
        }
        const raw = byKey.get(field.key);
        if (!raw) {
          report.failed.push({ key: field.key, reason: "field not found on the page" });
          continue;
        }
        try {
          await delay();
          await fillOne(page, spec, raw, field, value!);
          report.filled.push(field.key);
        } catch (err) {
          report.failed.push({ key: field.key, reason: msg(err) });
        }
      }
      // Answers can reveal follow-up questions ("If yes, explain"); a new required one must block submit.
      const afterScan = await scanForm(page, spec.scan).catch(() => null);
      for (const f of afterScan?.fields ?? [])
        if (f.required && !byKey.has(f.key) && !known.has(f.key))
          report.failed.push({ key: f.key, reason: `a new required question appeared after filling: "${f.label}"` });
      return report;
    },

    submit: (page) => submitForm(page, spec, delay, submitTimeout),
  };
}

async function fillOne(page: Page, spec: AdapterSpec, raw: RawField, field: FormField, value: FieldValue): Promise<void> {
  const loc = keyLocator(page, raw.key);
  const isFile = typeof value === "object" && !Array.isArray(value);
  if (raw.widget === "file") {
    if (!isFile) throw new Error("expected a file path");
    await fillFile(page, loc, value.file);
    await spec.afterFile?.(page, raw.key);
    return;
  }
  if (isFile) throw new Error("a file was given for a non-upload field");
  const str = Array.isArray(value) ? value.join(", ") : value;
  switch (raw.widget) {
    case "text":
      return fillText(loc, str, raw.type);
    case "date":
      return fillDate(loc, str, "date");
    case "datepicker":
      return fillDate(loc, str, "datepicker");
    case "select":
      return fillNativeSelect(loc, value as string | string[]);
    case "radio":
    case "yesno":
    case "checkbox":
      return fillChoiceGroup(page, raw, value);
    case "combobox":
      return fillCombobox(page, raw.key, Array.isArray(value) ? value : [value], field.options);
    case "typeahead":
      return fillTypeahead(page, raw.key, str, {
        location: field.role === "location",
        requireSelection: raw.type === "select",
        resultsSelector: raw.type === "select" ? undefined : spec.resultsSelector,
      });
  }
}

// ---------------------------------------------------------------------------
// Submit and confirm

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).locator("visible=true").first();
    if ((await loc.count()) > 0) return loc;
  }
  return null;
}

export async function submitForm(page: Page, spec: AdapterSpec, delay: Delay, timeoutMs: number): Promise<SubmitResult> {
  const captcha = await detectCaptcha(page);
  if (captcha.visible) return { status: "blocked", detail: `captcha present (${captcha.kind}); not submitted` };
  const button = await firstVisible(page, spec.submitButtons);
  if (!button) return { status: "blocked", detail: "submit button not found; not submitted" };

  const cfg = { formSelector: spec.formSelector, successSelector: spec.successSelector };
  const before = await snapshot(page, cfg);
  const startUrl = page.url();
  await delay();
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click({ timeout: 10_000 });

  const t0 = Date.now();
  let pendingErrors: string | null = null;
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(400).catch(() => {});
    let snap: PageSnapshot;
    try {
      snap = await snapshot(page, cfg);
    } catch {
      continue; // navigating
    }
    const url = page.url();
    const moved = url !== startUrl;
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      /* about:blank */
    }
    if (snap.successVisible) return { status: "submitted", confirmation: snap.confirmText ?? `success message shown at ${url}` };
    if (moved && CONFIRM_URL.test(pathname)) return { status: "submitted", confirmation: snap.confirmText ? `${snap.confirmText} (${url})` : url };
    if (snap.confirmText && (moved || snap.confirmCount > before.confirmCount || !snap.formPresent))
      return { status: "submitted", confirmation: snap.confirmText };

    const cap = await detectCaptcha(page);
    if (cap.visible) return { status: "blocked", detail: `captcha challenge appeared after submit (${cap.kind})` };

    const elapsed = Date.now() - t0;
    const newErrors = snap.errors.filter((e) => !before.errors.includes(e));
    const problems = [...newErrors, ...snap.invalid.map((l) => `invalid: ${l}`)];
    if (elapsed > 1000 && problems.length) {
      const sig = problems.join("; ");
      if (pendingErrors !== null) return { status: "blocked", detail: `validation errors: ${sig}` };
      pendingErrors = sig; // must persist across two polls
    } else pendingErrors = null;
    if (elapsed > 3000 && !moved && snap.formPresent && snap.nativeInvalid.length)
      return { status: "blocked", detail: `validation errors: ${snap.nativeInvalid.join("; ")}` };
  }
  return { status: "unknown", detail: `clicked submit but saw no confirmation within ${Math.round(timeoutMs / 1000)}s (now at ${page.url()})` };
}
