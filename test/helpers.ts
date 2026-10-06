import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Point every data path at a throwaway folder before any module reads paths.ts.
export const TMP = mkdtempSync(path.join(os.tmpdir(), "nuportal-test-"));
process.env.NUPORTAL_DATA_DIR = path.join(TMP, "data");
process.env.NUPORTAL_ME_DIR = path.join(TMP, "me");
process.env.NUPORTAL_QUIET = "1";
