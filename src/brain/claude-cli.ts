import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BRAIN_SANDBOX_DIR } from "../config/paths.js";
import type { Settings } from "../config/settings.js";
import { shortHash, which } from "../core/util.js";
import { type Brain, type BrainMeta, BrainOutputError, BrainUnavailableError, type StructuredRequest } from "./types.js";

// Runs your Claude subscription through headless Claude Code:
//   claude -p --output-format json --json-schema ... --tools "" --safe-mode
// No tools (posting text can't make it do anything), no CLAUDE.md, no plugins,
// no MCP servers, no saved sessions. The prompt goes in on stdin.

interface CliEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  api_error_status?: number | null;
}

const UNAVAILABLE = /(not logged in|failed to authenticate|oauth|usage limit|rate limit|limit reached|quota|overloaded|credit balance)/i;

export class ClaudeCliBrain implements Brain {
  private active = 0;
  private waiters: (() => void)[] = [];
  private bin: string | null = null;

  constructor(private readonly settings: Settings["brain"]) {}

  private async slot(): Promise<() => void> {
    if (this.active >= this.settings.concurrency) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiters.shift()?.();
    };
  }

  private async resolveBin(): Promise<string> {
    if (this.bin) return this.bin;
    const found = await which(this.settings.claudeBin);
    if (!found) throw new BrainUnavailableError(`Claude CLI "${this.settings.claudeBin}" not found on PATH`);
    this.bin = found;
    return found;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; meta: BrainMeta }> {
    const release = await this.slot();
    try {
      const schemaJson = cliSchema(req.schema);
      let prompt = req.prompt;
      let totalCost = 0;
      const started = Date.now();
      for (let attempt = 1; attempt <= 2; attempt++) {
        const env = await this.run(req, schemaJson, prompt);
        totalCost += env.total_cost_usd ?? 0;
        const parsed = req.schema.safeParse(extract(env));
        if (parsed.success) {
          return {
            data: parsed.data,
            meta: { model: this.model(req), costUsd: totalCost, durationMs: Date.now() - started, attempts: attempt },
          };
        }
        prompt = `${req.prompt}\n\nYour previous answer did not match the required JSON schema:\n${parsed.error.message.slice(0, 1500)}\nReturn only valid JSON for the schema.`;
      }
      throw new BrainOutputError(`${req.purpose}: no valid output after 2 attempts`);
    } finally {
      release();
    }
  }

  private model(req: StructuredRequest<unknown>): string {
    return req.tier === "score" ? this.settings.scoreModel : this.settings.writeModel;
  }

  private async run(req: StructuredRequest<unknown>, schemaJson: string, prompt: string): Promise<CliEnvelope> {
    const bin = await this.resolveBin();
    mkdirSync(BRAIN_SANDBOX_DIR, { recursive: true });
    // System prompts can be long (the humanizer's is ~25 KB); pass them as a file, not argv.
    const sysFile = path.join(BRAIN_SANDBOX_DIR, `system-${process.pid}-${shortHash(req.purpose + Math.random())}.md`);
    writeFileSync(sysFile, req.system);
    const effort = req.tier === "score" ? this.settings.scoreEffort : this.settings.writeEffort;
    const args = [
      "-p",
      "--output-format", "json",
      "--json-schema", schemaJson,
      "--tools", "",
      "--safe-mode",
      "--no-session-persistence",
      "--system-prompt-file", sysFile,
      "--model", this.model(req),
      "--effort", effort,
    ];
    try {
      const { stdout, stderr, code } = await exec(bin, args, prompt, req.timeoutMs ?? this.settings.timeoutMs);
      let env: CliEnvelope;
      try {
        env = JSON.parse(stdout) as CliEnvelope;
      } catch {
        const text = `${stdout}\n${stderr}`.trim();
        if (UNAVAILABLE.test(text)) throw new BrainUnavailableError(text.slice(0, 300));
        throw new BrainOutputError(`${req.purpose}: claude exited ${code} without JSON: ${text.slice(0, 300)}`);
      }
      if (env.is_error) {
        const msg = String(env.result ?? stderr ?? "unknown error");
        if (UNAVAILABLE.test(msg) || env.api_error_status === 429) throw new BrainUnavailableError(msg.slice(0, 300));
        throw new BrainOutputError(`${req.purpose}: ${msg.slice(0, 300)}`);
      }
      return env;
    } finally {
      rmSync(sysFile, { force: true });
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { data, meta } = await this.structured({
        purpose: "health",
        system: "You are a health check. Reply with the JSON requested.",
        prompt: 'Return {"ok": true}.',
        schema: z.object({ ok: z.boolean() }),
        tier: "score",
        timeoutMs: 90_000,
      });
      return { ok: data.ok, detail: `claude -p answered in ${(meta.durationMs / 1000).toFixed(1)} s (${meta.model})` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

// The CLI's validator only knows draft-07, so target it and drop the $schema URI.
export function cliSchema(schema: z.ZodType): string {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return JSON.stringify(rest);
}

// --json-schema puts the parsed object in structured_output; older builds put JSON text in result.
export function extract(env: CliEnvelope): unknown {
  if (env.structured_output !== undefined && env.structured_output !== null) return env.structured_output;
  const text = String(env.result ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  try {
    return JSON.parse(fenced ? fenced[1] : text);
  } catch {
    return undefined;
  }
}

function exec(bin: string, args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: BRAIN_SANDBOX_DIR,
      env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new BrainOutputError(`claude -p timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new BrainUnavailableError(`could not start claude: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(stdin);
  });
}
