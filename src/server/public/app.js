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

  // Start on the first card so A/S/D work without a click.
  const first = document.querySelector(".queue .card[data-job-id]");
  if (first && document.activeElement === document.body) first.focus({ preventScroll: true });
})();
