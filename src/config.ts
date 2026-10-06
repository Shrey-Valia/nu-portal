import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const NUWORKS_URL = "https://nuworks.northeastern.edu/students";

// Persistent Chrome profile that holds the NUworks session cookies. Gitignored.
export const BROWSER_PROFILE_DIR = path.join(ROOT, ".auth", "browser-profile");

export const DATA_DIR = path.join(ROOT, "data");

const PROFILE_PATH = path.join(ROOT, "config", "profile.json");

export interface Profile {
  targetRoles: string[];
  mustHaveKeywords: string[];
  niceToHaveKeywords: string[];
  excludeKeywords: string[];
  excludeCompanies: string[];
  locations: string[];
  remoteOk: boolean;
  minMatchScore: number;
  maxApplicationsPerRun: number;
  documents: {
    resumeName: string;
    coverLetterName: string | null;
  };
}

export function loadProfile(): Profile {
  if (!existsSync(PROFILE_PATH)) {
    throw new Error(
      "config/profile.json not found. Copy config/profile.example.json to config/profile.json and fill it in.",
    );
  }
  return JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as Profile;
}
