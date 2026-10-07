import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, LETTERS_DIR, REPORTS_DIR, ROOT, SCREENSHOTS_DIR, SETTINGS_PATH } from "../config/paths.js";
import { loadSettings, type Settings } from "../config/settings.js";
import type { Db } from "../db/db.js";
import { isDay } from "../core/time.js";
import { handleApi } from "./api.js";
import { type Ctx, HttpError, type SpawnApply } from "./context.js";
import { externalPage, historyPage, jobPage, learningPage, notFoundPage, offerPage, todayPage } from "./pages.js";
import { saveUpload } from "./setup-api.js";
import { claudeStatus, draftsPage, privatePage, profilePage, settingsPage, setupPage, tasksPage, tryPage, writingPage } from "./setup-pages.js";
import { type Spawner, TaskRunner } from "./tasks.js";

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const STATIC_FILES: Record<string, string> = {
  "app.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
};
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX_BODY = 256 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;
const MAX_UPLOAD = 15 * 1024 * 1024;

export interface ServerOptions {
  db: Db;
  port: number;
  host?: string;
  token?: string;
  settings?: Settings;
  settingsFile?: string;
  spawnApply?: SpawnApply;
  spawner?: Spawner; // how app tasks start processes (tests pass a fake)
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

interface Guard {
  hosts: Set<string>;
  origins: Set<string>;
}

// Detached so a dashboard restart doesn't kill a half-finished apply run.
export const spawnApplyCli: SpawnApply = ({ track, mode, liveToken }) => {
  const logsDir = path.join(DATA_DIR, "logs");
  mkdirSync(logsDir, { recursive: true });
  const log = path.join(logsDir, `apply-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const fd = openSync(log, "a");
  try {
    const env = { ...process.env };
    delete env.NUPORTAL_DASHBOARD_LIVE_TOKEN;
    if (liveToken) env.NUPORTAL_DASHBOARD_LIVE_TOKEN = liveToken;
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--import", "tsx", path.join(ROOT, "src", "cli.ts"), "apply", "--track", track, "--mode", mode, "--via", "dashboard"],
      { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env },
    );
    child.on("error", (err) => console.error(`apply run failed to start: ${err.message}`));
    child.unref();
    return { pid: child.pid ?? null, log };
  } finally {
    closeSync(fd);
  }
};

function baseHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const sendText = (res: ServerResponse, status: number, text: string) => send(res, status, "text/plain; charset=utf-8", text);
const sendHtml = (res: ServerResponse, status: number, page: string) => send(res, status, "text/html; charset=utf-8", page);
const sendJson = (res: ServerResponse, status: number, body: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(body));

// Hashing first makes the comparison constant-time regardless of length.
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return Promise.reject(new HttpError(415, "Send JSON with Content-Type: application/json"));
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return Promise.reject(new HttpError(413, "Request body too large"));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (size > MAX_BODY) return reject(new HttpError(413, "Request body too large"));
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        return reject(new HttpError(400, "Body is not valid JSON"));
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reject(new HttpError(400, "Body must be a JSON object"));
      resolve(parsed as Record<string, unknown>);
    });
  });
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers["content-length"] ?? 0) > MAX_UPLOAD) return Promise.reject(new HttpError(413, "File is too large (15 MB max)"));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_UPLOAD) chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => (size > MAX_UPLOAD ? reject(new HttpError(413, "File is too large (15 MB max)")) : resolve(Buffer.concat(chunks))));
  });
}

async function apiRequest(ctx: Ctx, guard: Guard, req: IncomingMessage, res: ServerResponse, method: string, pathname: string, search: URLSearchParams): Promise<void> {
  const given = req.headers["x-nuportal-token"];
  if (typeof given !== "string" || !tokenMatches(given, ctx.token)) return sendJson(res, 403, { error: "Missing or wrong dashboard token" });
  const origin = req.headers.origin;
  if (origin !== undefined && !guard.origins.has(origin)) return sendJson(res, 403, { error: "Cross-origin request refused" });
  const upload = method === "POST" ? pathname.match(/^\/api\/upload\/([a-z]+)$/) : null;
  if (upload) {
    const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/octet-stream") throw new HttpError(415, "Upload files as application/octet-stream");
    const result = saveUpload(ctx, upload[1], search.get("name"), await readRawBody(req));
    return sendJson(res, result.status, result.body);
  }
  const body = method === "POST" ? await readJsonBody(req) : {};
  const result = handleApi(ctx, method, pathname, body);
  sendJson(res, result.status, result.body);
}

function decodeParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function serveStatic(res: ServerResponse, name: string): void {
  const type = Object.hasOwn(STATIC_FILES, name) ? STATIC_FILES[name] : undefined;
  if (!type) return sendText(res, 404, "Not found");
  res.setHeader("Cache-Control", "no-cache");
  send(res, 200, type, readFileSync(path.join(PUBLIC_DIR, name)));
}

// Only image files that really live under SCREENSHOTS_DIR, after resolving
// "..", absolute paths and symlinks.
function serveScreenshot(res: ServerResponse, rest: string): void {
  const rel = decodeParam(rest);
  if (!rel || rel.includes("\0")) return sendText(res, 404, "Not found");
  const base = path.resolve(SCREENSHOTS_DIR);
  const file = path.resolve(base, rel);
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!file.startsWith(base + path.sep) || !type) return sendText(res, 404, "Not found");
  let real: string;
  try {
    real = realpathSync(file);
    const realBase = realpathSync(base);
    if (!real.startsWith(realBase + path.sep)) return sendText(res, 404, "Not found");
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_IMAGE) return sendText(res, 404, "Not found");
  } catch {
    return sendText(res, 404, "Not found");
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  send(res, 200, type, readFileSync(real));
}

// Letter PDFs that really live under LETTERS_DIR (same checks as screenshots).
function serveLetter(res: ServerResponse, rest: string): void {
  const rel = decodeParam(rest);
  if (!rel || rel.includes("\0")) return sendText(res, 404, "Not found");
  const base = path.resolve(LETTERS_DIR);
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep) || path.extname(file).toLowerCase() !== ".pdf") return sendText(res, 404, "Not found");
  try {
    const real = realpathSync(file);
    if (!real.startsWith(realpathSync(base) + path.sep) || !statSync(real).isFile()) return sendText(res, 404, "Not found");
    res.setHeader("Content-Disposition", "inline");
    send(res, 200, "application/pdf", readFileSync(real));
  } catch {
    sendText(res, 404, "Not found");
  }
}

// Saved reports carry one inline <style>; allow exactly that by hash and nothing else.
function serveReport(res: ServerResponse, rawDay: string): void {
  const day = decodeParam(rawDay);
  if (!day || !isDay(day)) return sendHtml(res, 404, "<!doctype html><title>Not found</title><p>No such report.</p>");
  let page: string;
  try {
    page = readFileSync(path.join(REPORTS_DIR, `${day}.html`), "utf8");
  } catch {
    return sendHtml(res, 404, "<!doctype html><title>Not found</title><p>No report saved for that day.</p>");
  }
  const hashes = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src ${hashes.join(" ") || "'none'"}; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  sendHtml(res, 200, page);
}

async function handle(ctx: Ctx, guard: Guard, req: IncomingMessage, res: ServerResponse): Promise<void> {
  baseHeaders(res);
  // DNS-rebinding defense: a browser tricked into calling us under another name sends that name here.
  if (!guard.hosts.has(req.headers.host ?? "")) return sendText(res, 403, "Forbidden: unexpected Host header");
  const method = req.method ?? "GET";
  let pathname: string;
  let search: URLSearchParams;
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    pathname = url.pathname;
    search = url.searchParams;
  } catch {
    return sendText(res, 400, "Bad request");
  }

  if (pathname.startsWith("/api/")) return apiRequest(ctx, guard, req, res, method, pathname, search);
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return sendText(res, 405, "Method not allowed");
  }

  let m: RegExpMatchArray | null;
  if (pathname === "/") return sendHtml(res, 200, todayPage(ctx));
  if (pathname === "/history") return sendHtml(res, 200, historyPage(ctx));
  if (pathname === "/external") return sendHtml(res, 200, externalPage(ctx));
  if (pathname === "/learning") return sendHtml(res, 200, learningPage(ctx));
  if (pathname === "/offer") return sendHtml(res, 200, offerPage(ctx));
  if (pathname === "/setup") return sendHtml(res, 200, setupPage(ctx, await claudeStatus(ctx.settings)));
  if (pathname === "/profile") return sendHtml(res, 200, profilePage(ctx, search.get("from") === "draft"));
  if (pathname === "/private") return sendHtml(res, 200, privatePage(ctx));
  if (pathname === "/writing") return sendHtml(res, 200, writingPage(ctx));
  if (pathname === "/drafts") return sendHtml(res, 200, draftsPage(ctx));
  if (pathname === "/settings") return sendHtml(res, 200, settingsPage(ctx));
  if (pathname === "/tasks") return sendHtml(res, 200, tasksPage(ctx));
  if (pathname === "/try") return sendHtml(res, 200, tryPage(ctx));
  if (pathname.startsWith("/letters/")) return serveLetter(res, pathname.slice("/letters/".length));
  if ((m = pathname.match(/^\/jobs\/([^/]+)$/))) {
    const id = decodeParam(m[1]);
    const page = id ? jobPage(ctx, id) : null;
    return page ? sendHtml(res, 200, page) : sendHtml(res, 404, notFoundPage(ctx, "Job"));
  }
  if ((m = pathname.match(/^\/reports\/([^/]+)$/))) return serveReport(res, m[1]);
  if (pathname.startsWith("/screenshots/")) return serveScreenshot(res, pathname.slice("/screenshots/".length));
  if ((m = pathname.match(/^\/static\/([^/]+)$/))) return serveStatic(res, m[1]);
  sendHtml(res, 404, notFoundPage(ctx));
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`The dashboard only binds to 127.0.0.1 (got "${host}")`);
  const token = opts.token ?? randomBytes(32).toString("base64url");
  const ctx = {
    db: opts.db,
    settings: opts.settings ?? loadSettings(),
    settingsFile: opts.settingsFile ?? SETTINGS_PATH,
    token,
    port: opts.port,
  } as Ctx;
  ctx.tasks = new TaskRunner(() => ctx.settings, opts.spawner);
  // Job-list runs go through the task runner (live ones confirm each application in the app).
  ctx.spawnApply =
    opts.spawnApply ??
    ((r) => {
      const kind = r.track === "nuworks" ? (r.mode === "live" ? "apply-nuworks-live" : "apply-nuworks-dry") : r.mode === "live" ? "apply-live" : "apply-dry";
      const t = ctx.tasks.start(kind, { liveToken: r.liveToken ?? undefined, watch: true });
      return { pid: t.pid, log: t.log };
    });
  const guard: Guard = { hosts: new Set(), origins: new Set() };

  const server = http.createServer((req, res) => {
    handle(ctx, guard, req, res).catch((err: unknown) => {
      if (res.headersSent) return res.destroy();
      if (!req.complete) res.setHeader("Connection", "close");
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : "Something went wrong. Check the terminal running the dashboard.";
      if (!(err instanceof HttpError)) console.error(err);
      if ((req.url ?? "").startsWith("/api/")) sendJson(res, status, { error: message });
      else sendText(res, status, message);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  ctx.port = port;
  for (const name of ["127.0.0.1", "localhost"]) {
    guard.hosts.add(`${name}:${port}`);
    guard.origins.add(`http://${name}:${port}`);
  }

  return {
    url: `http://${host}:${port}/`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
