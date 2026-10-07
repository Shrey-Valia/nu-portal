import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Tests point NUPORTAL_DATA_DIR at a temp folder so they never touch real data.
export const DATA_DIR = process.env.NUPORTAL_DATA_DIR ?? path.join(ROOT, "data");
export const ME_DIR = process.env.NUPORTAL_ME_DIR ?? path.join(ROOT, "me");

export const AUTH_DIR = path.join(ROOT, ".auth");
export const BROWSER_PROFILE_DIR = path.join(AUTH_DIR, "browser-profile");

export const DB_PATH = path.join(DATA_DIR, "nuportal.db");
export const REPORTS_DIR = path.join(DATA_DIR, "reports");
export const BACKUPS_DIR = path.join(DATA_DIR, "backups");
export const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
export const LETTERS_DIR = path.join(DATA_DIR, "letters");
export const SOURCES_DIR = path.join(DATA_DIR, "sources");
export const LOCKS_DIR = path.join(DATA_DIR, "locks");
// Headless `claude -p` runs from this empty folder so it never loads the
// project's CLAUDE.md or MCP servers.
export const BRAIN_SANDBOX_DIR = path.join(DATA_DIR, "brain-sandbox");

// Tests point this at a temp file so your own settings never affect them.
export const SETTINGS_PATH = process.env.NUPORTAL_SETTINGS ?? path.join(ROOT, "config", "settings.yaml");
export const SETTINGS_EXAMPLE_PATH = path.join(ROOT, "config", "settings.example.yaml");
export const MIGRATIONS_DIR = path.join(ROOT, "src", "db", "migrations");

export const NUWORKS_URL = "https://nuworks.northeastern.edu/students";
export const NUWORKS_HOSTS = ["nuworks.northeastern.edu", "northeastern-csm.symplicity.com"];
