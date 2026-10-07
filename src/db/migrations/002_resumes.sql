-- Resumes tailored to one job: reordered and lightly reworded from your profile.
-- Versioned like writings; the PDF lives under data/letters/resumes/.
CREATE TABLE resumes (
  id             INTEGER PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES jobs(id),
  version        INTEGER NOT NULL,
  data           TEXT NOT NULL,          -- JSON: skill groups + per-experience bullets, each citing a profile id
  changes        TEXT,                   -- JSON array: what was moved or reworded, in plain words
  reverted       TEXT,                   -- JSON array: bullets that failed checks and kept your wording
  pdf_path       TEXT,
  is_current     INTEGER NOT NULL DEFAULT 1,
  model          TEXT,
  prompt_version TEXT,
  profile_version TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX resumes_job ON resumes(job_id);
