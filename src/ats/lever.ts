import { type AdapterOptions, createAdapter, type DescribingAdapter, inPage, type RawField } from "./common.js";
import { applyUrlFor, detectAts } from "./detect.js";

// Lever (jobs.lever.co/<company>/<posting-id>/apply). Server-rendered <form id="application-form"
// method=POST enctype=multipart/form-data>:
// - standard fields are <li class="application-question"><label><div class="application-label">Text
//   <span class="required">✱</span></div><div class="application-field"><input name=...></div></label>
//   (resume = input[name=resume] inside the "ATTACH RESUME/CV" button; Lever parses it and pre-fills
//   name/email/phone/company; location = #location-input with a suggestion dropdown + hidden selectedLocation)
// - links: urls[LinkedIn], urls[GitHub], urls[Portfolio], urls[Other]
// - "cards" (custom questions): cards[<cardId>][field<i>] radios/checkboxes/selects/textareas, with the
//   card definition (labels, required, options) in a hidden cards[<cardId>][baseTemplate] JSON input
// - EEO: selects eeo[gender], eeo[race], eeo[veteran] (+ eeo[disability] on some boards)
// - invisible hCaptcha (hidden enclave iframes), a Cloudflare bot-check script, a cookie banner
// - submit: button#btn-submit (type=button; JS runs hCaptcha then posts); success -> .../thanks
//   ("Application submitted!"). Closed postings return HTTP 404 "Sorry, we couldn't find anything here".

interface CardInfo {
  label: string;
  required: boolean;
  options: string[];
  description: string;
}

function readCards(): Record<string, CardInfo> {
  const out: Record<string, CardInfo> = {};
  for (const h of Array.from(document.querySelectorAll('input[type="hidden"][name$="[baseTemplate]"]'))) {
    const name = h.getAttribute("name") || "";
    const m = name.match(/^cards\[([^\]]+)\]\[baseTemplate\]$/);
    if (!m) continue;
    let tpl: { fields?: { text?: string; required?: boolean; description?: string; options?: { text?: string }[] }[] };
    try {
      tpl = JSON.parse((h as HTMLInputElement).value);
    } catch {
      continue;
    }
    (tpl.fields || []).forEach((f, i) => {
      out["cards[" + m[1] + "][field" + i + "]"] = {
        label: (f.text || "").trim(),
        required: !!f.required,
        options: (f.options || []).map((o) => (o.text || "").trim()).filter(Boolean),
        description: (f.description || "").trim(),
      };
    });
  }
  return out;
}

function applyCards(fields: RawField[], cards: Record<string, CardInfo>): void {
  for (const f of fields) {
    const c = cards[f.key] ?? cards[f.name];
    if (!c) continue;
    if (!f.label && c.label) f.label = c.label;
    f.required = f.required || c.required;
    if (!f.options?.length && c.options.length && f.widget !== "text") f.options = c.options;
    if (!f.description && c.description) f.description = c.description.slice(0, 500);
  }
}

export function createLeverAdapter(opts: AdapterOptions = {}): DescribingAdapter {
  return createAdapter(
    {
      kind: "lever",
      matches: (url) => detectAts(url) === "lever",
      formUrl: (url) => applyUrlFor("lever", url),
      ready: ["#application-form", "form.application-form", "text=/couldn't find anything here/i"],
      formSelector: "#application-form",
      scan: {
        root: ["#application-form"],
        container: "li.application-question, div.application-question",
        questionLabel: ".application-label",
        description: ".application-field-description, .description",
        exclude: "#hcaptchaResponseInput, .h-captcha, #selected-location",
        typeahead: "#location-input, input.location-input",
      },
      resultsSelector: ".dropdown-results > *",
      submitButtons: ["#btn-submit", "button[data-qa='btn-submit']", "button.template-btn-submit", "#application-form button[type=submit]"],
      isClosed: (_url, text) => /couldn'?t find anything here|posting you'?re looking for might have closed/i.test(text),

      async prepare(page) {
        // Cookie banner: take the privacy-preserving choice so it does not cover the form.
        const deny = page.locator(".cc-window .cc-deny, button.cc-deny").locator("visible=true").first();
        if (await deny.count()) await deny.click({ timeout: 2000 }).catch(() => {});
      },

      async meta(page) {
        const title = (await page.locator(".posting-headline h2, .posting-header h2").first().innerText({ timeout: 1000 }).catch(() => "")).trim();
        const t = await page.title();
        const i = t.indexOf(" - ");
        return { company: i > 0 ? t.slice(0, i).trim() : null, title: title || (i > 0 ? t.slice(i + 3).trim() : null) };
      },

      async enrich(page, _url, fields) {
        const cards = await page.evaluate(inPage(readCards)).catch(() => ({}));
        applyCards(fields, cards);
      },

      async afterFile(page, key) {
        if (key !== "resume" && !/resume/.test(key)) return;
        // Lever uploads and parses the resume, then may pre-fill fields; wait for that to settle.
        const working = page.locator(".resume-upload-working").first();
        await working.waitFor({ state: "visible", timeout: 1500 }).catch(() => {});
        await working.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
      },
    },
    opts,
  );
}

export const lever: DescribingAdapter = createLeverAdapter();
