// NU Portal dashboard behavior. The pages are server-rendered; this file adds
// the buttons, keyboard shortcuts and run polling. It lives in /static/ so the
// CSP can forbid inline scripts entirely.
(() => {
  "use strict";

  const token = document.querySelector('meta[name="nuportal-token"]')?.getAttribute("content") ?? "";

  async function api(path, body, method = "POST") {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", "X-NUPortal-Token": token },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(message, kind = "info") {
    const el = document.querySelector("[data-toast]");
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, kind === "error" ? 7000 : 3500);
  }

  // ---------- Review cards

  const cards = () => [...document.querySelectorAll(".card[data-job-id]")];
  const cardOf = (el) => (el instanceof Element ? el.closest(".card[data-job-id]") : null);
  const DONE_TEXT = { approve: "Approved", skip: "Skipped", defer: "Deferred" };

  function focusSibling(card, step) {
    const all = cards();
    const next = all[all.indexOf(card) + step];
    if (next) {
      next.focus();
      next.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function updateQueueCount() {
    const n = document.querySelectorAll(".queue .card[data-job-id]").length;
    const count = document.querySelector("[data-queue-count]");
    if (count) count.textContent = String(n);
    const emptyNote = document.querySelector("[data-queue-empty]");
    if (emptyNote) emptyNote.hidden = n > 0;
  }

  async function decide(card, decision, extra = {}) {
    if (card.classList.contains("busy")) return;
    card.classList.add("busy");
    try {
      await api(`/api/jobs/${encodeURIComponent(card.dataset.jobId)}/decision`, { decision, ...extra });
      toast(`${DONE_TEXT[decision]}: ${card.dataset.title ?? "job"}`);
      if (card.dataset.after === "reload") {
        location.reload();
        return;
      }
      const all = cards();
      const next = all[all.indexOf(card) + 1] ?? all[all.indexOf(card) - 1];
      card.remove();
      updateQueueCount();
      if (next) next.focus();
    } catch (err) {
      card.classList.remove("busy");
      toast(err.message, "error");
    }
  }

  function skipPanel(card) {
    return card.querySelector("[data-skip-panel]");
  }

  function openSkip(card) {
    const panel = skipPanel(card);
    if (!panel) return;
    panel.hidden = false;
    card.querySelector('[data-action="skip"]')?.setAttribute("aria-expanded", "true");
    panel.querySelector('input[name="reason"]')?.focus();
  }

  function closeSkip(card) {
    const panel = skipPanel(card);
    if (!panel) return;
    panel.hidden = true;
    card.querySelector('[data-action="skip"]')?.setAttribute("aria-expanded", "false");
    card.focus();
  }

  function confirmSkip(card) {
    const panel = skipPanel(card);
    const reasonTags = [...panel.querySelectorAll('input[name="reason"]:checked')].map((i) => i.value);
    const note = panel.querySelector('input[name="note"]')?.value.trim() || undefined;
    decide(card, "skip", { reasonTags, note });
  }

  async function saveLetter(card, button) {
    const textarea = card.querySelector("textarea[name='body']");
    const status = card.querySelector("[data-letter-status]");
    const body = textarea?.value.trim();
    if (!body) {
      toast("The letter is empty.", "error");
      return;
    }
    button.disabled = true;
    try {
      const res = await api(`/api/jobs/${encodeURIComponent(card.dataset.jobId)}/letter`, { body });
      const version = card.querySelector("[data-letter-version]");
      if (version) version.textContent = `v${res.version} · edited`;
      const preview = card.querySelector("[data-letter-preview]");
      if (preview) preview.textContent = body.replace(/\s+/g, " ").slice(0, 220);
      if (status) status.textContent = `Saved as v${res.version}`;
      toast(`Cover letter saved (v${res.version})`);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Apply runs

  let pollTimer;
  function renderRun(box, data, startedAfter) {
    const run = data.run;
    box.replaceChildren();
    if (!run || Date.parse(run.started_at) < startedAfter) {
      box.textContent = "Waiting for the run to start…";
      return false;
    }
    const head = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = `${run.kind}${run.mode ? ` · ${run.mode}` : ""}`;
    head.append(strong, ` — ${run.status}`);
    box.append(head);
    const list = document.createElement("ol");
    for (const e of data.events.slice(-12)) {
      const li = document.createElement("li");
      li.textContent = `${e.level === "info" ? "" : `[${e.level}] `}${e.message}`;
      list.append(li);
    }
    if (list.childElementCount) box.append(list);
    return run.status !== "running";
  }

  function pollRun(startedAfter) {
    const box = document.querySelector("[data-run-status]");
    if (!box) return;
    box.hidden = false;
    box.textContent = "Starting…";
    clearInterval(pollTimer);
    let ticks = 0;
    pollTimer = setInterval(async () => {
      ticks++;
      try {
        const done = renderRun(box, await api("/api/runs/latest", null, "GET"), startedAfter);
        if (done || ticks > 600) clearInterval(pollTimer);
      } catch (err) {
        box.textContent = err.message;
        clearInterval(pollTimer);
      }
    }, 3000);
  }

  async function startApply(button) {
    const track = button.dataset.applyTrack;
    const mode = button.dataset.applyMode;
    const name = track === "nuworks" ? "NUworks" : "external";
    if (mode === "live" && !confirm(`Submit your approved ${name} applications for real?\n\nThis sends applications to employers.`)) return;
    button.disabled = true;
    const startedAfter = Date.now() - 5000;
    try {
      const res = await api("/api/apply", { track, mode });
      toast(`${mode === "live" ? "Live" : "Dry"} run started (process ${res.pid})`);
      pollRun(startedAfter);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Events

  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const applyBtn = target.closest("[data-apply-track]");
    if (applyBtn) return void startApply(applyBtn);

    const proposalBtn = target.closest("[data-proposal-id]");
    if (proposalBtn) {
      const box = proposalBtn.closest("[data-proposal]");
      api(`/api/proposals/${encodeURIComponent(proposalBtn.dataset.proposalId)}`, { status: proposalBtn.dataset.status })
        .then(() => {
          box?.querySelectorAll("button").forEach((b) => (b.disabled = true));
          const result = box?.querySelector("[data-proposal-result]");
          if (result) result.textContent = proposalBtn.dataset.status === "accepted" ? "Accepted" : "Rejected";
        })
        .catch((err) => toast(err.message, "error"));
      return;
    }

    const actionBtn = target.closest("[data-action]");
    const card = cardOf(actionBtn);
    if (!actionBtn || !card) return;
    switch (actionBtn.dataset.action) {
      case "approve":
        return void decide(card, "approve");
      case "defer":
        return void decide(card, "defer");
      case "skip":
        return skipPanel(card)?.hidden ? openSkip(card) : closeSkip(card);
      case "cancel-skip":
        return closeSkip(card);
      case "confirm-skip":
        return confirmSkip(card);
      case "save-letter":
        return void saveLetter(card, actionBtn);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    const card = cardOf(target);
    if (!card) return;
    if (e.key === "Escape" && !skipPanel(card)?.hidden) {
      e.preventDefault();
      return closeSkip(card);
    }
    // Typing in the letter, note or reason chips must never trigger shortcuts.
    if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"))) return;
    switch (e.key.toLowerCase()) {
      case "a":
        e.preventDefault();
        return void decide(card, "approve");
      case "s":
        e.preventDefault();
        return openSkip(card);
      case "d":
        e.preventDefault();
        return void decide(card, "defer");
      case "j":
        e.preventDefault();
        return focusSibling(card, 1);
      case "k":
        e.preventDefault();
        return focusSibling(card, -1);
    }
  });

  // ---------- Offer kill switch

  document.querySelector('[data-form="halt"]')?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const employer = form.elements.employer.value.trim();
    const date = form.elements.date.value;
    if (!confirm(`Stop everything because you accepted an offer from ${employer}?`)) return;
    try {
      const res = await api("/api/halt", { employer, date });
      toast(`Halted ${res.halted} jobs`);
      location.reload();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  document.querySelector('[data-form="halt-clear"]')?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/halt/clear", { confirm: e.currentTarget.elements.confirm.value });
      location.reload();
    } catch (err) {
      toast(err.message, "error");
    }
  });


  // ---------- App screens: forms, uploads, tasks, drafts, live confirmations

  function showIssues(form, err) {
    const box = form.querySelector("[data-issues]");
    if (!box) return toast(err.message, "error");
    box.replaceChildren();
    for (const issue of err.issues ?? [err.message]) {
      const li = document.createElement("li");
      li.textContent = issue;
      box.append(li);
    }
    box.hidden = false;
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-NUPortal-Token": token },
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
      cache: "no-store",
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.issues = data.issues;
      throw err;
    }
    return data;
  }

  function serialize(form) {
    const wrap = form.dataset.wrap;
    const out = {};
    const inner = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled || el.type === "submit" || el.type === "button") continue;
      const target = wrap && !el.hasAttribute("data-top") ? inner : out;
      if (el.type === "checkbox") {
        if (el.hasAttribute("data-multi")) {
          target[el.name] ??= [];
          if (el.checked) target[el.name].push(el.value);
        } else target[el.name] = el.checked;
      } else if (el.hasAttribute("data-bool")) target[el.name] = el.value === "true";
      else target[el.name] = el.value;
    }
    if (wrap) out[wrap] = inner;
    return out;
  }

  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches("[data-api]")) {
      e.preventDefault();
      const button = form.querySelector('[type="submit"]');
      if (button) button.disabled = true;
      form.querySelector("[data-issues]")?.setAttribute("hidden", "");
      try {
        await post(form.dataset.api, serialize(form));
        toast("Saved");
        if (form.dataset.after) setTimeout(() => (location.href = form.dataset.after), 500);
        else if (form.hasAttribute("data-reload")) setTimeout(() => location.reload(), 500);
      } catch (err) {
        showIssues(form, err);
      } finally {
        if (button) button.disabled = false;
      }
    } else if (form.matches("[data-answers]")) {
      e.preventDefault();
      const answers = [...form.querySelectorAll("[data-answer-row]")].map((row) => ({
        id: row.querySelector('[name="id"]').value,
        match: row.querySelector('[name="match"]').value,
        answer: row.querySelector('[name="answer"]').value,
      }));
      try {
        const res = await post("/api/answers", { answers });
        form.querySelector("[data-issues]")?.setAttribute("hidden", "");
        toast(`Saved ${res.count} answers`);
      } catch (err) {
        showIssues(form, err);
      }
    } else if (form.matches("[data-try]")) {
      e.preventDefault();
      const input = Object.fromEntries(["employer", "title", "posting", "question"].map((k) => [k, form.elements[k].value]));
      startTask("letter-sample", input);
    }
  });

  // Uploads go up as raw bytes; the server checks they're real PDFs.
  document.addEventListener("change", async (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("[data-upload]") || !input.files?.length) return;
    try {
      for (const file of input.files) {
        const res = await fetch(`/api/upload/${input.dataset.upload}?name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-NUPortal-Token": token },
          body: file,
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      }
      toast("Uploaded");
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      input.value = "";
    }
  });

  let taskTimer;
  function renderTask(box, t) {
    box.replaceChildren();
    const head = document.createElement("div");
    head.className = "task-head";
    const title = document.createElement("strong");
    title.textContent = t.label;
    const pillEl = document.createElement("span");
    pillEl.className = `pill pill-${t.status === "ok" ? "ok" : t.status === "failed" ? "bad" : "info"}`;
    pillEl.textContent = t.status === "running" ? "running…" : t.status === "ok" ? "done" : "failed";
    head.append(title, pillEl);
    if (t.pdfHref) {
      const a = document.createElement("a");
      a.href = t.pdfHref;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "btn";
      a.textContent = "Open PDF";
      head.append(a);
    }
    const pre = document.createElement("pre");
    pre.className = "task-log";
    pre.textContent = t.output || (t.status === "running" ? "Starting…" : "(no output)");
    box.append(head, pre);
    pre.scrollTop = pre.scrollHeight;
  }

  function watchTask(id) {
    const box = document.querySelector("[data-task-log]");
    if (!box) return void (location.href = "/tasks");
    box.hidden = false;
    clearInterval(taskTimer);
    const tick = async () => {
      try {
        const t = await api(`/api/tasks/${encodeURIComponent(id)}`, null, "GET");
        renderTask(box, t);
        if (t.status !== "running") clearInterval(taskTimer);
      } catch (err) {
        box.textContent = err.message;
        clearInterval(taskTimer);
      }
    };
    tick();
    taskTimer = setInterval(tick, 1500);
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function startTask(kind, input = {}) {
    try {
      const res = await post("/api/tasks", { kind, input });
      if (kind === "login") toast("A Chrome window is opening. Sign in, wait for your NUworks dashboard, then close it.");
      else toast(`${res.task.label} started`);
      const list = document.querySelector(".task-list");
      if (list) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "linklike";
        b.dataset.showTask = res.task.id;
        b.textContent = res.task.label;
        const pillEl = document.createElement("span");
        pillEl.className = "pill pill-info";
        pillEl.textContent = "started";
        li.append(b, pillEl);
        list.prepend(li);
        list.closest(".panel")?.querySelector(".empty")?.remove();
      }
      if (document.querySelector("[data-task-log]")) watchTask(res.task.id);
      else location.href = "/tasks";
    } catch (err) {
      toast(err.message, "error");
    }
  }

  document.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const taskBtn = t.closest("[data-task]");
    if (taskBtn) {
      let input = {};
      try {
        input = JSON.parse(taskBtn.dataset.taskInput || "{}");
      } catch {
        /* ignore */
      }
      return void startTask(taskBtn.dataset.task, input);
    }
    const show = t.closest("[data-show-task]");
    if (show) return void watchTask(show.dataset.showTask);
    const open = t.closest("[data-open]");
    if (open) {
      try {
        await post(`/api/open/${open.dataset.open}`);
        toast("Terminal opened. Follow the prompts there, then reload this page.");
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }
    const folder = t.closest("[data-open-folder]");
    if (folder) return void post("/api/open/folder", { which: folder.dataset.openFolder }).catch((err) => toast(err.message, "error"));
    const draft = t.closest("[data-draft]");
    if (draft) {
      const action = draft.dataset.draftAction;
      if (action === "discard" && !confirm(`Discard the ${draft.dataset.draft} draft?`)) return;
      try {
        await post(`/api/drafts/${encodeURIComponent(draft.dataset.draft)}/${action}`);
        toast(action === "accept" ? "Saved" : "Discarded");
        draft.closest("[data-draft-box]")?.remove();
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }
    if (t.closest("[data-add-row]")) {
      const tpl = document.querySelector("[data-answer-template]");
      document.querySelector("[data-answer-rows]")?.append(tpl.content.cloneNode(true));
      return;
    }
    const remove = t.closest("[data-remove-row]");
    if (remove) return void remove.closest("[data-answer-row]")?.remove();
  });

  const initialTask = document.querySelector("[data-initial-task]")?.dataset.initialTask;
  if (initialTask) watchTask(initialTask);

  // Live job-list runs pause before each submit; you decide here with the screenshot in front of you.
  const confirmBox = document.querySelector("[data-confirm-panel]");
  if (confirmBox) {
    let shownId = null;
    const render = (state) => {
      const p = state.pending;
      if (!p) {
        shownId = null;
        if (state.running) {
          confirmBox.hidden = false;
          confirmBox.replaceChildren();
          const note = document.createElement("p");
          note.textContent = "Filling in the next application… watch the Chrome window.";
          confirmBox.append(note);
        } else confirmBox.hidden = true;
        return;
      }
      if (shownId === p.id) return;
      shownId = p.id;
      confirmBox.hidden = false;
      confirmBox.replaceChildren();
      const h = document.createElement("h3");
      h.textContent = "Ready to submit?";
      const pre = document.createElement("pre");
      pre.textContent = p.summary;
      confirmBox.append(h, pre);
      if (p.screenshot) {
        const a = document.createElement("a");
        a.href = p.screenshot;
        a.target = "_blank";
        a.rel = "noopener";
        const img = document.createElement("img");
        img.src = p.screenshot;
        img.alt = "The filled-in application";
        a.append(img);
        confirmBox.append(a);
      }
      const row = document.createElement("div");
      row.className = "row";
      for (const [decision, text, cls] of [["submit", "Submit this application", "btn warn"], ["skip", "Skip", "btn"]]) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.textContent = text;
        b.addEventListener("click", async () => {
          row.querySelectorAll("button").forEach((x) => (x.disabled = true));
          try {
            await post("/api/apply/confirm", { id: p.id, decision });
            toast(decision === "submit" ? "Submitting…" : "Skipped");
          } catch (err) {
            toast(err.message, "error");
          }
        });
        row.append(b);
      }
      confirmBox.append(row);
      confirmBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const poll = async () => {
      try {
        render(await api("/api/apply/pending", null, "GET"));
      } catch {
        /* dashboard restarting */
      }
    };
    poll();
    setInterval(poll, 2000);
  }

  // Start on the first card so A/S/D work without a click.
  const first = document.querySelector(".queue .card[data-job-id]");
  if (first && document.activeElement === document.body) first.focus({ preventScroll: true });
})();
