import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { SETTINGS_PATH } from "./paths.js";

const range = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const adapterMode = z.enum(["off", "supervised", "auto"]);

export const SettingsSchema = z.object({
  timezone: z.string().default("America/New_York"),
  cycle: z
    .object({
      label: z.string().default("Spring 2027"),
      cap: z.number().int().positive().default(100),
      reserve: z.number().int().nonnegative().default(10),
      seasonEnd: z.string().default("2027-01-08"),
    })
    .prefault({}),
  nuworks: z
    .object({
      // Co-op terms to search, e.g. ["Spring 2027", "Summer 2027"]. Empty = just cycle.label.
      terms: z.array(z.string()).default([]),
      // Extra NUworks job-search filters, exactly as the site sends them (from recon):
      // job_type=5 is Co-op; targeted_academic_majors and el_work_term take NUworks ids.
      searchParams: z.record(z.string(), z.string()).default({ job_type: "5", exclude_applied_jobs: "1" }),
      maxPagesPerRun: z.number().int().positive().default(80),
      maxDetailsPerRun: z.number().int().positive().default(150),
      weeklyLimit: z.number().int().positive().default(20),
      minDailyQueue: z.number().int().nonnegative().default(2),
      maxDailyQueue: z.number().int().positive().default(10),
      maxPerEmployer: z.number().int().positive().default(2),
      minScore: z.number().int().min(0).max(100).default(60),
      maxScoresPerDay: z.number().int().positive().default(150),
      coverLetters: z.enum(["required", "whenAccepted"]).default("required"),
      // A resume reordered and lightly reworded for each queued job (you get each one approved).
      tailorResume: z.boolean().default(true),
    })
    .prefault({}),
  external: z
    .object({
      enabled: z.boolean().default(false),
      repos: z.array(z.string()).default([]),
      terms: z.array(z.string()).default(["Spring 2027"]),
      maxPerDay: z.number().int().nonnegative().default(25),
      maxPerCompany: z.number().int().positive().default(3),
      postedWithinDays: z.number().int().positive().default(21),
      minRelevance: z.number().int().min(0).max(100).default(60),
      coverLetters: z.enum(["required", "whenAccepted"]).default("required"),
      tailorResume: z.boolean().default(true),
      adapters: z
        .object({
          greenhouse: adapterMode.default("off"),
          lever: adapterMode.default("off"),
          ashby: adapterMode.default("off"),
        })
        .prefault({}),
    })
    .prefault({}),
  pacing: z
    .object({
      actionDelayMs: range.default([1200, 3500]),
      nuworksBetweenAppsMs: range.default([60_000, 180_000]),
      externalBetweenAppsMs: range.default([45_000, 120_000]),
    })
    .prefault({}),
  brain: z
    .object({
      claudeBin: z.string().default("claude"),
      scoreModel: z.string().default("opus"),
      scoreEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
      writeModel: z.string().default("opus"),
      writeEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
      timeoutMs: z.number().int().positive().default(240_000),
      concurrency: z.number().int().min(1).max(4).default(2),
    })
    .prefault({}),
  schedule: z
    .object({
      dailyTime: z.string().regex(/^\d{2}:\d{2}$/).default("08:30"),
      weekdaysOnly: z.boolean().default(true),
    })
    .prefault({}),
  server: z.object({ port: z.number().int().default(4317) }).prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

let cached: Settings | undefined;

export function loadSettings(file = SETTINGS_PATH): Settings {
  if (cached && file === SETTINGS_PATH) return cached;
  const raw = existsSync(file) ? parse(readFileSync(file, "utf8")) ?? {} : {};
  const settings = SettingsSchema.parse(raw);
  if (file === SETTINGS_PATH) cached = settings;
  return settings;
}

// Saves settings from the app. Throws a ZodError if anything is out of range.
export function saveSettings(input: unknown, file = SETTINGS_PATH): Settings {
  const settings = SettingsSchema.parse(input);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# NU Portal settings. Edit here or in the app (Settings).\n${stringify(settings)}`);
  if (file === SETTINGS_PATH) cached = settings;
  return settings;
}

// The co-op terms NUworks searches and filters on.
export function nuworksTerms(s: Settings): string[] {
  return s.nuworks.terms.length ? s.nuworks.terms : [s.cycle.label];
}
