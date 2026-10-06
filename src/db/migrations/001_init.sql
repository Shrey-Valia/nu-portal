-- Every job from every source. Status follows src/core/states.ts.
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,           -- "nuworks:<id>" or "ext:<hash of apply url>"
  source        TEXT NOT NULL,              -- "nuworks" or "repo:<owner>/<name>"
  source_job_id TEXT,
  title         TEXT NOT NULL,
  employer      TEXT NOT NULL,
  location      TEXT,
  modality      TEXT,                       -- onsite | hybrid | remote | unknown
  term          TEXT,                       -- e.g. "Spring 2027"
  pay_text      TEXT,
  deadline_at   TEXT,                       -- ISO 8601 UTC
  posted_at     TEXT,
  apply_method  TEXT NOT NULL DEFAULT 'unknown',  -- nuworks | external | unknown
  apply_url     TEXT,
  ats           TEXT,                       -- greenhouse | lever | ashby | workday | ...
  cover_letter  TEXT NOT NULL DEFAULT 'unknown',  -- required | optional | not_accepted | unknown
  required_docs TEXT,                       -- JSON array
  qualifications TEXT,                      -- JSON: majors, levels, minGpa, citizenship
  description   TEXT,
  raw           TEXT,                       -- JSON as received
  content_hash  TEXT,
  fingerprint   TEXT NOT NULL,              -- employer|title|location, normalized
  status        TEXT NOT NULL DEFAULT 'discovered',
  status_reason TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX jobs_status ON jobs(status);
CREATE INDEX jobs_fingerprint ON jobs(fingerprint);
CREATE INDEX jobs_source ON jobs(source);

CREATE TABLE scores (
  id                  INTEGER PRIMARY KEY,
  job_id              TEXT NOT NULL REFERENCES jobs(id),
  scored_at           TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'fit',   -- fit | relevance
  score               INTEGER NOT NULL,
  why                 TEXT NOT NULL,
  matched             TEXT,                          -- JSON array of profile ids
  gaps                TEXT,                          -- JSON array
  red_flags           TEXT,                          -- JSON array
  suspected_injection INTEGER NOT NULL DEFAULT 0,
  model               TEXT,
  prompt_version      TEXT,
  profile_version     TEXT
);
CREATE INDEX scores_job ON scores(job_id);

CREATE TABLE decisions (
  id                INTEGER PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  decision          TEXT NOT NULL CHECK (decision IN ('approve', 'skip', 'defer')),
  decided_by        TEXT NOT NULL DEFAULT 'user',    -- user | auto
  reason_tags       TEXT,                            -- JSON array
  note              TEXT,
  score_at_decision INTEGER,
  decided_at        TEXT NOT NULL
);
CREATE INDEX decisions_job ON decisions(job_id);

-- Cover letters and written answers. Versioned; never overwritten.
CREATE TABLE writings (
  id             INTEGER PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES jobs(id),
  kind           TEXT NOT NULL CHECK (kind IN ('cover_letter', 'answer')),
  question       TEXT,
  version        INTEGER NOT NULL,
  source         TEXT NOT NULL,                      -- draft | edit | regen
  draft          TEXT,                               -- before the humanizer
  body           TEXT NOT NULL,                      -- after the humanizer (or your edit)
  claims         TEXT,                               -- JSON: [{text, sourceId}]
  lint           TEXT,                               -- JSON: {ok, problems[]}
  is_current     INTEGER NOT NULL DEFAULT 1,
  pdf_path       TEXT,
  model          TEXT,
  prompt_version TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX writings_job ON writings(job_id);

-- One row per real submission attempt (live or applied by hand). Dry runs and
-- rehearsals never create rows here.
CREATE TABLE applications (
  id               INTEGER PRIMARY KEY,
  job_id           TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  track            TEXT NOT NULL CHECK (track IN ('nuworks', 'external')),
  cycle_id         INTEGER REFERENCES cycles(id),
  via              TEXT NOT NULL CHECK (via IN ('tool', 'manual')),
  result           TEXT NOT NULL,                    -- submitting | submitted | needs_manual | failed | submit_unknown
  error            TEXT,
  letter_id        INTEGER REFERENCES writings(id),
  answers          TEXT,                             -- JSON: [{question, writingId | value}]
  screenshots      TEXT,                             -- JSON array of paths
  started_at       TEXT NOT NULL,
  submitted_at     TEXT,
  remote_status    TEXT,                             -- viewed | interview | rejected | offer | withdrawn ...
  remote_status_at TEXT
);

CREATE TABLE cycles (
  id         INTEGER PRIMARY KEY,
  label      TEXT NOT NULL UNIQUE,
  cap        INTEGER NOT NULL,
  reserve    INTEGER NOT NULL,
  season_end TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE cap_snapshots (
  id            INTEGER PRIMARY KEY,
  cycle_id      INTEGER NOT NULL REFERENCES cycles(id),
  taken_at      TEXT NOT NULL,
  nuworks_count INTEGER,
  cap_shown     INTEGER,
  raw           TEXT
);

CREATE TABLE runs (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,                      -- daily | apply-nuworks | apply-external | sync | reflect | session-check
  mode           TEXT,                               -- dry-run | rehearsal | live
  requested_via  TEXT,                               -- cli | dashboard | schedule
  job_ids        TEXT,
  pid            INTEGER,
  status         TEXT NOT NULL,                      -- running | ok | failed | halted
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  summary        TEXT,
  brain_calls    INTEGER NOT NULL DEFAULT 0,
  brain_cost_usd REAL NOT NULL DEFAULT 0
);

-- Append-only log. Daily reports are built from this table.
CREATE TABLE events (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL,
  run_id  INTEGER REFERENCES runs(id),
  job_id  TEXT,
  level   TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  kind    TEXT NOT NULL,
  message TEXT NOT NULL,
  data    TEXT
);
CREATE INDEX events_ts ON events(ts);
CREATE INDEX events_job ON events(job_id);

CREATE TABLE proposals (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind       TEXT NOT NULL,                          -- preference | voice | rule | threshold
  payload    TEXT NOT NULL,
  evidence   TEXT,
  status     TEXT NOT NULL DEFAULT 'open',           -- open | accepted | rejected
  decided_at TEXT
);

CREATE TABLE profile_versions (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  file       TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL                           -- user | proposal
);

-- Small runtime flags: halt switch, session status, adapter graduation.
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
