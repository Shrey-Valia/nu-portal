import { type AdapterOptions, createAdapter, type DescribingAdapter } from "./common.js";
import { applyUrlFor, detectAts } from "./detect.js";

// Ashby (jobs.ashbyhq.com/<company>/<posting-id>/application). A React SPA; the form is built from a
// GraphQL query after load, and there is no <form> element.
// - each question: div.ashby-application-form-field-entry[data-field-path] with
//   label.ashby-application-form-question-title[for]; required questions carry a hashed CSS-module
//   class "_required_xxxxx" on the label (the asterisk is a ::after)
// - system fields: _systemfield_name, _systemfield_email, _systemfield_resume (file input),
//   _systemfield_location (input[role=combobox].ashby-application-form-input-autocomplete, async)
// - yes/no questions: two buttons (data-option=yes/no, aria-pressed) plus a hidden checkbox
// - radio groups / checkbox groups: fieldset.ashby-application-form-input-radio-group / -checkbox-group
//   (checkbox name = option text), dates: react-datepicker text input "Pick date..."
// - EEO survey in .ashby-survey-form-container (_systemfield_eeoc_gender/race/veteran_status radios)
// - an "Autofill from resume" uploader at the top (ignored), invisible reCAPTCHA v2 (badge hidden)
// - submit: button.ashby-application-form-submit-button; success replaces the form in place.
//   Missing postings render "Job not found".

export function createAshbyAdapter(opts: AdapterOptions = {}): DescribingAdapter {
  return createAdapter(
    {
      kind: "ashby",
      matches: (url) => detectAts(url) === "ashby",
      formUrl: (url) => applyUrlFor("ashby", url),
      ready: [".ashby-application-form-field-entry", ".ashby-application-form-container", "text=/job not found/i"],
      formSelector: ".ashby-application-form-container",
      successSelector: ".ashby-application-form-success-container",
      scan: {
        root: ["#form", "[role=tabpanel]", ".ashby-job-posting-right-pane"],
        container: ".ashby-application-form-field-entry, [data-field-path]",
        questionLabel: ".ashby-application-form-question-title",
        description: ".ashby-application-form-question-description",
        exclude: ".ashby-application-form-autofill-uploader, .ashby-application-form-autofill-input-root",
        requiredClass: "(^|\\s)_required_",
        keyAttr: "data-field-path",
        yesno: ".ashby-application-form-input-yesno",
        typeahead: "input.ashby-application-form-input-autocomplete, [data-field-path] input[role=combobox][aria-autocomplete=list]",
        datepicker: "input.ashby-application-form-input-date, .react-datepicker__input-container input",
      },
      submitButtons: ["button.ashby-application-form-submit-button", "button:has-text('Submit Application')"],
      isClosed: (_url, text) => /\bjob not found\b|the job you requested was not found/i.test(text),

      async meta(page) {
        const title = (await page.locator("h1.ashby-job-posting-heading, h1").first().innerText({ timeout: 1000 }).catch(() => "")).trim();
        const t = await page.title();
        const at = t.lastIndexOf(" @ ");
        return { title: title || (at > 0 ? t.slice(0, at).trim() : null), company: at > 0 ? t.slice(at + 3).trim() : null };
      },

      async afterFile(page, key) {
        // The file is uploaded right away; wait for any spinner in that question to finish.
        const spinner = page.locator(`[data-field-path="${key}"] [role=progressbar]`).first();
        await spinner.waitFor({ state: "visible", timeout: 1500 }).catch(() => {});
        await spinner.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
      },
    },
    opts,
  );
}

export const ashby: DescribingAdapter = createAshbyAdapter();
