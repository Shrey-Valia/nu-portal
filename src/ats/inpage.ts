import type { FieldType } from "./types.js";

// Functions in this file run INSIDE the browser page (via `inPage()` in common.ts).
// Rules: no imports at runtime, no references to anything outside the function body,
// only browser globals. Types are fine (they vanish at compile time).

export type Widget =
  | "text" // input/textarea filled with .fill()
  | "select" // native <select>
  | "radio" // radio group
  | "checkbox" // checkbox group or single checkbox
  | "yesno" // pair of Yes/No buttons (Ashby)
  | "file"
  | "combobox" // react-select style dropdown with a fixed option list
  | "typeahead" // search-as-you-type suggestions (locations, schools)
  | "date" // native <input type=date>
  | "datepicker"; // text input driven by a JS date picker

export interface ScanConfig {
  root?: string[]; // candidate selectors for the form root; first match wins
  container?: string; // wrapper around one question
  questionLabel?: string; // question text inside a container
  description?: string; // helper text inside a container
  exclude?: string; // controls (or their ancestors) to ignore
  requiredClass?: string; // regex source; a label whose class matches it marks a required field
  keyAttr?: string; // ancestor attribute that names the field (Ashby: data-field-path)
  yesno?: string; // Yes/No button groups
  typeahead?: string; // inputs whose options come from searching
  datepicker?: string; // text inputs backed by a date picker
}

export interface RawField {
  key: string;
  name: string; // raw name/id, used as a classification hint
  label: string;
  type: FieldType;
  widget: Widget;
  required: boolean;
  options?: string[];
  multiple?: boolean;
  maxLength?: number;
  description?: string;
}

export interface ScanResult {
  formFound: boolean;
  fields: RawField[];
  unknownRequired: string[];
}

// Describe every fillable control in the form and tag each with data-nup-key / data-nup-group
// so the Node side can find it again without fragile selectors.
export function scanDom(cfg: ScanConfig): ScanResult {
  const norm = (s: string | null | undefined): string => (s || "").replace(/\s+/g, " ").trim();
  const REQ = /[*✱]|\(required\)/i;
  const GENERIC =
    /^(attach|attach file|upload|upload file|upload a file|browse|choose file|choose a file|select file|drop files here|enter manually|or|select\.{0,3}|click here|type here\.{0,3}|start typing\.{0,3})$/i;
  const clean = (s: string): string =>
    norm(s.replace(/\(required\)/gi, " ").replace(/[*✱]/g, " ")).replace(/[:\s]+$/, "");
  const isVisible = (el: Element | null): boolean => {
    if (!el) return false;
    if (!(el as HTMLElement).getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const textOf = (el: Element | null): string => (el ? norm((el as HTMLElement).innerText ?? el.textContent) : "");
  const cls = (el: Element | null): string => (el && typeof el.className === "string" ? el.className : "");
  const byId = (id: string): Element | null => (id ? document.getElementById(id) : null);
  const labelForId = (id: string): Element[] =>
    id ? Array.from(document.querySelectorAll('label[for="' + CSS.escape(id) + '"]')) : [];

  // Root.
  let root: Element | null = null;
  let rootMatched = false;
  for (const sel of cfg.root || []) {
    const el = document.querySelector(sel);
    if (el) {
      root = el;
      rootMatched = true;
      break;
    }
  }
  if (!root) {
    let best: Element | null = null;
    let most = 0;
    for (const f of Array.from(document.querySelectorAll("form"))) {
      const n = f.querySelectorAll("input:not([type=hidden]), select, textarea").length;
      if (n > most) {
        most = n;
        best = f;
      }
    }
    root = best || document.body;
    rootMatched = !!best;
  }
  root.querySelectorAll("[data-nup-key]").forEach((e) => e.removeAttribute("data-nup-key"));
  root.querySelectorAll("[data-nup-group]").forEach((e) => {
    e.removeAttribute("data-nup-group");
    e.removeAttribute("data-nup-option");
  });

  const BUILTIN_EXCLUDE =
    '.g-recaptcha, .h-captcha, .grecaptcha-badge, .cf-turnstile, [name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]';
  const excluded = (el: Element): boolean => {
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (el.tagName === "INPUT" && ["hidden", "submit", "button", "reset", "image", "search"].includes(t)) return true;
    if (el.getAttribute("aria-hidden") === "true" && el.getAttribute("tabindex") === "-1" && t !== "checkbox" && t !== "radio")
      return true;
    if (el.closest(BUILTIN_EXCLUDE)) return true;
    if (cfg.exclude && el.closest(cfg.exclude)) return true;
    if ((el as HTMLInputElement).disabled) return true;
    return false;
  };

  type Lbl = { text: string; el: Element | null };
  const none: Lbl = { text: "", el: null };

  // Text of a <label> that wraps its control, minus the control itself.
  const labelPart = (label: Element, control: Element): string => {
    for (const c of Array.from(label.querySelectorAll("*"))) {
      if (c.contains(control) || c.querySelector("input,select,textarea")) continue;
      if (/label|title|question|prompt/i.test(cls(c)) && textOf(c)) return textOf(c);
    }
    const clone = label.cloneNode(true) as Element;
    clone
      .querySelectorAll("input,select,textarea,option,button,ul,ol,script,style,[aria-hidden=true]")
      .forEach((n) => n.remove());
    return norm(clone.textContent);
  };

  const containerOf = (el: Element): Element | null => (cfg.container ? el.closest(cfg.container) : null);

  const isOptionLabel = (l: Element, self: Element | null): boolean => {
    const f = l.getAttribute("for");
    if (!f) return false;
    const t = byId(f) as HTMLInputElement | null;
    return !!t && t !== self && (t.type === "radio" || t.type === "checkbox");
  };

  const questionText = (el: Element): Lbl => {
    const c = containerOf(el);
    if (!c || !cfg.questionLabel) return none;
    for (const q of Array.from(c.querySelectorAll(cfg.questionLabel))) {
      if (q.contains(el)) {
        const t = labelPart(q, el);
        if (t) return { text: t, el: q };
        continue;
      }
      if (q.querySelector("input,select,textarea")) continue;
      if (isOptionLabel(q, el)) continue;
      const t = textOf(q);
      if (t) return { text: t, el: q };
    }
    return none;
  };

  const labelledBy = (el: Element | null): Lbl => {
    const ids = el?.getAttribute("aria-labelledby");
    if (!ids) return none;
    const parts = ids
      .split(/\s+/)
      .map((i) => byId(i))
      .filter((x): x is Element => !!x);
    return parts.length ? { text: parts.map(textOf).join(" "), el: parts[0] } : none;
  };

  const labelsFor = (el: Element): Lbl[] => {
    const out: Lbl[] = [];
    for (const l of labelForId(el.getAttribute("id") || ""))
      out.push({ text: l.contains(el) ? labelPart(l, el) : textOf(l), el: l });
    out.push(labelledBy(el));
    const wrap = el.closest("label");
    if (wrap) out.push({ text: labelPart(wrap, el), el: wrap });
    out.push(questionText(el));
    const grp = el.parentElement?.closest("[role=group][aria-labelledby], [role=radiogroup][aria-labelledby]") ?? null;
    out.push(labelledBy(grp));
    const al = el.getAttribute("aria-label");
    if (al) out.push({ text: al, el: null });
    const ph = el.getAttribute("placeholder");
    if (ph) out.push({ text: ph, el: null });
    const title = el.getAttribute("title");
    if (title) out.push({ text: title, el: null });
    return out;
  };

  const groupLabels = (inputs: Element[], box: Element | null): Lbl[] => {
    const out: Lbl[] = [];
    if (box && box.tagName === "FIELDSET") {
      const lg = box.querySelector(":scope > legend");
      if (lg) out.push({ text: textOf(lg), el: lg });
    }
    if (box) {
      for (const l of Array.from(box.querySelectorAll("label, legend, [class*=label], [class*=title], [class*=question]"))) {
        if (inputs.some((i) => l.contains(i) || i.contains(l))) continue;
        if (l.querySelector("input, button")) continue;
        const f = l.getAttribute("for");
        if (f && inputs.some((i) => i.id === f)) continue;
        if (isOptionLabel(l, null)) continue;
        const t = textOf(l);
        if (t) {
          out.push({ text: t, el: l });
          break;
        }
      }
      out.push(labelledBy(box));
    }
    out.push(questionText(inputs[0]));
    out.push(labelledBy(inputs[0].closest("[role=radiogroup][aria-labelledby], [role=group][aria-labelledby]")));
    return out;
  };

  const pick = (cands: Lbl[]): Lbl => {
    for (const c of cands) {
      const t = clean(c.text);
      if (t && !GENERIC.test(t)) return c;
    }
    return none;
  };

  const reqClass = cfg.requiredClass ? new RegExp(cfg.requiredClass) : null;
  const markedRequired = (lbl: Lbl): boolean => {
    if (REQ.test(lbl.text)) return true;
    const e = lbl.el;
    if (!e) return false;
    if (e.querySelector(".required, .asterisk, [class*=required]")) return true;
    if (reqClass && reqClass.test(cls(e))) return true;
    return false;
  };
  const groupRequired = (el: Element): boolean =>
    !!el.parentElement?.closest(
      'fieldset[aria-required="true"], [role=group][aria-required="true"], [role=radiogroup][aria-required="true"]',
    );

  const optionText = (inp: Element): string => optionRaw(inp).replace(/\s*[*✱]\s*$/, "");
  const optionRaw = (inp: Element): string => {
    for (const l of labelForId(inp.getAttribute("id") || "")) {
      if (l.contains(inp)) continue;
      const t = textOf(l);
      if (t) return t;
    }
    const w = inp.closest("label");
    if (w) {
      const clone = w.cloneNode(true) as Element;
      clone.querySelectorAll("input,select,textarea,script,style").forEach((n) => n.remove());
      const t = norm(clone.textContent);
      if (t) return t;
    }
    const al = inp.getAttribute("aria-label");
    if (al) return norm(al);
    const v = (inp as HTMLInputElement).value;
    if (v && v !== "on") return v;
    return textOf(inp.nextElementSibling);
  };

  const describe = (el: Element): string | undefined => {
    const parts: string[] = [];
    const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter((i) => i && !/error|placeholder/i.test(i));
    for (const i of ids) {
      const n = byId(i);
      if (n && isVisible(n)) {
        const t = textOf(n);
        if (t) parts.push(t);
      }
    }
    if (!parts.length && cfg.description) {
      const n = containerOf(el)?.querySelector(cfg.description) ?? null;
      if (n && isVisible(n)) parts.push(textOf(n));
    }
    const s = norm(parts.join(" "));
    return s ? s.slice(0, 500) : undefined;
  };

  const selectOptions = (s: HTMLSelectElement): string[] =>
    Array.from(s.options)
      .filter((o, i) => {
        const t = norm(o.text);
        if (!t || (o.disabled && i === 0)) return false;
        if (o.value === "") return false;
        if (i === 0 && /^(select|choose|please select|-+|click here|none selected)/i.test(t)) return false;
        return true;
      })
      .map((o) => norm(o.text));

  const used = new Set<string>();
  const uniqueKey = (k: string): string => {
    const base = k || "field";
    let key = base;
    let n = 2;
    while (used.has(key)) key = base + "#" + n++;
    used.add(key);
    return key;
  };
  const attrKey = (el: Element): string | null => {
    if (!cfg.keyAttr) return null;
    const c = el.closest("[" + cfg.keyAttr + "]");
    return c ? c.getAttribute(cfg.keyAttr) : null;
  };

  const fields: RawField[] = [];
  const anchors: Element[] = []; // element each field starts at, for DOM ordering
  const seen = new Set<Element>();

  // Yes/No button pairs.
  if (cfg.yesno) {
    for (const box of Array.from(root.querySelectorAll(cfg.yesno))) {
      if (!isVisible(box)) continue;
      const buttons = Array.from(box.querySelectorAll("button, [role=button], [role=radio]"));
      if (!buttons.length) continue;
      box.querySelectorAll("input").forEach((i) => seen.add(i));
      const hidden = box.querySelector("input");
      const key = uniqueKey(attrKey(box) || hidden?.getAttribute("name") || box.id || "yesno");
      const lbl = pick(groupLabels(buttons, box.parentElement));
      box.setAttribute("data-nup-key", key);
      const options = buttons.map((b) => textOf(b));
      buttons.forEach((b, i) => {
        b.setAttribute("data-nup-group", key);
        b.setAttribute("data-nup-option", options[i]);
      });
      anchors.push(box);
      fields.push({
        key,
        name: key,
        label: clean(lbl.text),
        type: "radio",
        widget: "yesno",
        required: markedRequired(lbl) || !!hidden?.hasAttribute("required"),
        options,
      });
    }
  }

  const controls = Array.from(root.querySelectorAll("input, select, textarea, [role=combobox]"));
  for (const el of controls) {
    if (seen.has(el) || excluded(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const name = el.getAttribute("name") || "";
    const id = el.getAttribute("id") || "";

    if (tag === "input" && (type === "radio" || type === "checkbox")) {
      // Group members.
      let members: Element[] = [el];
      let box: Element | null = null;
      let groupName = "";
      const fs = el.closest("fieldset");
      const sameName = name
        ? Array.from(root.querySelectorAll('input[type="' + type + '"][name="' + CSS.escape(name) + '"]'))
        : [];
      if (type === "radio") {
        if (sameName.length) {
          members = sameName;
          groupName = name;
        } else if (fs) members = Array.from(fs.querySelectorAll('input[type="radio"]'));
      } else {
        const inFs = fs ? Array.from(fs.querySelectorAll('input[type="checkbox"]')) : [];
        const names = new Set(inFs.map((i) => i.getAttribute("name") || ""));
        if (fs && (names.size === 1 || names.size === inFs.length)) {
          members = inFs;
          if (names.size === 1) groupName = name;
        } else if (sameName.length > 1) {
          members = sameName;
          groupName = name;
        }
      }
      members = members.filter((m) => !excluded(m));
      members.forEach((m) => seen.add(m));
      if (!members.length) continue;
      if (fs && members.every((m) => fs.contains(m))) box = fs;
      else box = containerOf(members[0]);
      const anyVisible = members.some(
        (m) => isVisible(m) || labelForId(m.getAttribute("id") || "").some(isVisible) || isVisible(m.closest("label")),
      );
      if (!anyVisible) continue;
      const options = members.map(optionText);
      const single = type === "checkbox" && members.length === 1;
      let lbl = pick(groupLabels(members, box));
      if (single && !lbl.text) lbl = pick(labelsFor(el));
      const key = uniqueKey(attrKey(el) || groupName || (box && box.id) || id || name || type);
      members.forEach((m, i) => {
        m.setAttribute("data-nup-group", key);
        m.setAttribute("data-nup-option", options[i]);
      });
      anchors.push(members[0]);
      fields.push({
        key,
        name: groupName || name || id,
        label: clean(lbl.text) || options[0] || "",
        type: type === "radio" ? "radio" : "checkbox",
        widget: type === "radio" ? "radio" : "checkbox",
        required:
          members.some((m) => (m as HTMLInputElement).required || m.getAttribute("aria-required") === "true") ||
          (!!box && box.getAttribute("aria-required") === "true") ||
          groupRequired(members[0]) ||
          markedRequired(lbl),
        options,
        multiple: type === "checkbox" && members.length > 1,
      });
      continue;
    }

    // Single controls.
    const isCombo = el.getAttribute("role") === "combobox";
    const isFile = tag === "input" && type === "file";
    const shown =
      isVisible(el) ||
      ((isFile || isCombo) && (isVisible(containerOf(el)) || isVisible(el.parentElement) || labelForId(id).some(isVisible)));
    if (!shown) continue;
    seen.add(el);
    const lbl = pick(labelsFor(el));
    const key = uniqueKey(attrKey(el) || id || name || tag);
    let ftype: FieldType = "text";
    let widget: Widget = "text";
    let options: string[] | undefined;
    let multiple = false;
    if (tag === "select") {
      const s = el as HTMLSelectElement;
      options = selectOptions(s);
      multiple = s.multiple;
      ftype = multiple ? "checkbox" : "select";
      widget = "select";
    } else if (tag === "textarea") {
      ftype = "textarea";
    } else if (cfg.datepicker && el.matches(cfg.datepicker)) {
      ftype = "date";
      widget = "datepicker";
    } else if (cfg.typeahead && el.matches(cfg.typeahead)) {
      ftype = isCombo ? "select" : "text";
      widget = "typeahead";
    } else if (isCombo) {
      ftype = "select";
      widget = "combobox";
    } else if (isFile) {
      ftype = "file";
      widget = "file";
    } else if (type === "date") {
      ftype = "date";
      widget = "date";
    } else if (["email", "tel", "url", "number"].includes(type)) {
      ftype = type as FieldType;
    }
    const ml = (el as HTMLInputElement).maxLength;
    el.setAttribute("data-nup-key", key);
    anchors.push(el);
    fields.push({
      key,
      name: name || id,
      label: clean(lbl.text),
      type: ftype,
      widget,
      required:
        (el as HTMLInputElement).required ||
        el.getAttribute("aria-required") === "true" ||
        groupRequired(el) ||
        markedRequired(lbl),
      options,
      multiple,
      maxLength: ml > 0 && ml < 100000 ? ml : undefined,
      description: describe(el),
    });
  }

  // Required questions whose control we could not recognize.
  const unknownRequired: string[] = [];
  if (cfg.container) {
    for (const c of Array.from(root.querySelectorAll(cfg.container))) {
      if (!isVisible(c)) continue;
      const tagged = "[data-nup-key], [data-nup-group]";
      if (c.querySelector(tagged) || c.closest("[data-nup-key]")) continue;
      // A nested wrapper inside a question we already understood (e.g. the label half of a field).
      if (c.parentElement?.closest(cfg.container)?.querySelector(tagged)) continue;
      const q = cfg.questionLabel ? c.querySelector(cfg.questionLabel) : null;
      const lbl: Lbl = { text: q ? textOf(q) : "", el: q };
      if (!clean(lbl.text)) continue;
      if (!markedRequired(lbl) && !c.querySelector('[required], [aria-required="true"]')) continue;
      unknownRequired.push(clean(lbl.text));
    }
  }

  const order = fields.map((_, i) => i);
  order.sort((a, b) => (anchors[a].compareDocumentPosition(anchors[b]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const sorted = order.map((i) => fields[i]);
  return { formFound: sorted.length > 0 && (rootMatched || root.tagName === "FORM"), fields: sorted, unknownRequired };
}

export interface CaptchaState {
  visible: boolean; // an interactive captcha (checkbox, challenge, Turnstile, interstitial) is showing
  passive: boolean; // an invisible/score-based captcha is loaded (normal for these ATSs)
  kind: string | null;
}

export function captchaDom(): CaptchaState {
  const shown = (el: Element, minH: number): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < minH) return false;
    let n: Element | null = el;
    while (n) {
      const cs = getComputedStyle(n);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
      n = n.parentElement;
    }
    return true;
  };
  let passive = false;
  let kind: string | null = null;
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    let u: URL | null = null;
    try {
      u = new URL(f.getAttribute("src") || "about:blank", location.href);
    } catch {
      u = null;
    }
    if (!u) continue;
    const path = u.pathname;
    const host = u.hostname;
    const hash = u.hash;
    if (/\/recaptcha\/(api2|enterprise)\/anchor/.test(path)) {
      if (u.searchParams.get("size") === "invisible") passive = true;
      else if (shown(f, 30)) kind = "reCAPTCHA";
    } else if (/\/recaptcha\/(api2|enterprise)\/bframe/.test(path)) {
      if (shown(f, 100)) kind = "reCAPTCHA challenge";
      else passive = true;
    } else if (/hcaptcha/.test(host) || /hcaptcha/.test(path)) {
      if (/frame=challenge/.test(hash)) {
        if (shown(f, 100)) kind = "hCaptcha challenge";
      } else if (/frame=checkbox/.test(hash) && shown(f, 30)) kind = "hCaptcha";
      else passive = true;
    } else if (/challenges\.cloudflare\.com/.test(host)) {
      if (shown(f, 30)) kind = "Cloudflare Turnstile";
      else passive = true;
    } else if (/arkoselabs|funcaptcha/.test(host)) {
      if (shown(f, 30)) kind = "Arkose";
    }
    if (kind) break;
  }
  if (!kind) {
    for (const el of Array.from(document.querySelectorAll(".g-recaptcha, .h-captcha, .cf-turnstile"))) {
      if (el.getAttribute("data-size") === "invisible" || el.querySelector("iframe")) {
        passive = true;
        continue;
      }
      if (shown(el, 40)) {
        kind = "captcha widget";
        break;
      }
    }
  }
  if (!kind) {
    const t = (document.body?.innerText || "").slice(0, 20000);
    if (
      /verify (that )?you are (a )?human|are you a robot|confirm you('| a)re (a )?human|complete the security check|press (and|&) hold/i.test(t) ||
      /^just a moment/i.test(document.title)
    )
      kind = "human verification page";
  }
  return { visible: !!kind, passive, kind };
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string; // first part of the visible text
  passwordVisible: boolean;
  formPresent: boolean;
  successVisible: boolean;
  confirmText: string | null;
  confirmCount: number;
  errors: string[];
  invalid: string[]; // aria-invalid controls
  nativeInvalid: string[]; // visible controls failing HTML constraint validation
}

export function snapshotDom(cfg: { formSelector: string; successSelector?: string; confirmText: string }): PageSnapshot {
  const norm = (s: string | null | undefined): string => (s || "").replace(/\s+/g, " ").trim();
  const vis = (el: Element | null): boolean =>
    !!el && (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const body = document.body ? document.body.innerText || "" : "";
  const confirmRe = new RegExp(cfg.confirmText, "gi");
  const matches = body.match(confirmRe) || [];
  const labelOf = (el: Element): string => {
    const id = el.getAttribute("id");
    const l = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
    const t =
      norm(l ? (l as HTMLElement).innerText : "") ||
      norm(el.getAttribute("aria-label")) ||
      norm(el.closest("label") ? (el.closest("label") as HTMLElement).innerText : "") ||
      el.getAttribute("name") ||
      id ||
      el.tagName.toLowerCase();
    return t.replace(/[*✱]/g, "").trim().slice(0, 120);
  };

  const errors = new Set<string>();
  const errSel =
    '[role=alert], .error, .errors, .error-message, .error-msg, .field-error, .field-error-msg, .helper-text--error, .invalid-feedback, .application-error, [class*="error" i], [id$="-error"]';
  for (const el of Array.from(document.querySelectorAll(errSel))) {
    if (el.matches("input, select, textarea, form, body, html, label")) continue;
    if (el.querySelector("input, select, textarea")) continue;
    if (!vis(el)) continue;
    const t = norm((el as HTMLElement).innerText);
    if (!t || t.length > 300) continue;
    errors.add(t);
  }

  const invalid = new Set<string>();
  const nativeInvalid = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "hidden" || el.getAttribute("aria-hidden") === "true") continue;
    const shown = vis(el) || ((type === "radio" || type === "checkbox" || type === "file") && vis(el.parentElement));
    if (!shown) continue;
    if (el.getAttribute("aria-invalid") === "true") invalid.add(labelOf(el));
    const v = (el as HTMLInputElement).validity;
    if (v && !v.valid && (el as HTMLInputElement).willValidate) {
      const form = (el as HTMLInputElement).form;
      if (form && form.noValidate) continue;
      nativeInvalid.add(labelOf(el) + ": " + ((el as HTMLInputElement).validationMessage || "invalid"));
    }
  }

  const form = document.querySelector(cfg.formSelector);
  return {
    url: location.href,
    title: document.title,
    text: body.slice(0, 5000),
    passwordVisible: Array.from(document.querySelectorAll('input[type="password"]')).some(vis),
    formPresent: vis(form),
    successVisible: !!cfg.successSelector && Array.from(document.querySelectorAll(cfg.successSelector)).some(vis),
    confirmText: matches.length ? norm(matches[0]) : null,
    confirmCount: matches.length,
    errors: Array.from(errors),
    invalid: Array.from(invalid),
    nativeInvalid: Array.from(nativeInvalid),
  };
}
