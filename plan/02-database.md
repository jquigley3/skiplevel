# 02 — SQLite Job Queue

## Schema

One table. Simple. The unit of work is a single Claude Code CLI invocation.

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,         -- UUID v4 (or caller-provided ID)
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  prompt      TEXT NOT NULL,            -- The prompt to send to Claude Code
  project_dir TEXT NOT NULL,            -- Absolute path to the project directory (host path)

  -- Optional configuration (all nullable — defaults applied at dispatch time)
  model             TEXT,               -- e.g. 'claude-sonnet-4-5'
  max_turns         INTEGER,
  max_budget_usd    REAL,
  system_prompt     TEXT,               -- Replaces default system prompt
  append_system_prompt TEXT,            -- Appended to default system prompt
  permission_mode   TEXT DEFAULT 'bypassPermissions',
  allowed_tools     TEXT,               -- JSON array: ["Bash","Read","Write"]
  disallowed_tools  TEXT,               -- JSON array
  claude_md         TEXT,               -- Contents of CLAUDE.md to inject (not a path)
  extra_env         TEXT,               -- JSON object: {"KEY":"value"}

  -- Scheduling
  priority    INTEGER NOT NULL DEFAULT 0,  -- Lower number = higher priority (0 is highest)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT,
  finished_at TEXT,

  -- Result (populated when status = done or failed)
  exit_code       INTEGER,
  result_text     TEXT,               -- Final response text from Claude
  transcript      TEXT,               -- Full stream-json transcript (JSONL)
  cost_usd        REAL,               -- Total cost reported by Claude
  error           TEXT,               -- Error message if failed
  duration_ms     INTEGER,

  -- Worker metadata
  worker_container TEXT,              -- Docker container name
  worktree_path    TEXT,              -- Path to the git worktree used
  worktree_branch  TEXT               -- Branch name of the worktree
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority, created_at);
```

## db.ts Implementation

```typescript
// src/db.ts
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

import { DB_PATH } from './config.js';
import { logger } from './logger.js';

let db: Database.Database;

export interface Job {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  prompt: string;
  project_dir: string;
  model: string | null;
  max_turns: number | null;
  max_budget_usd: number | null;
  system_prompt: string | null;
  append_system_prompt: string | null;
  permission_mode: string;
  allowed_tools: string | null; // JSON array string
  disallowed_tools: string | null; // JSON array string
  claude_md: string | null;
  extra_env: string | null; // JSON object string
  priority: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  result_text: string | null;
  transcript: string | null;
  cost_usd: number | null;
  error: string | null;
  duration_ms: number | null;
  worker_container: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
}

export interface CreateJobInput {
  id?: string; // Optional — auto-generated if omitted
  prompt: string;
  project_dir: string;
  model?: string;
  max_turns?: number;
  max_budget_usd?: number;
  system_prompt?: string;
  append_system_prompt?: string;
  permission_mode?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  claude_md?: string;
  extra_env?: Record<string, string>;
  priority?: number;
}

export function initDb(): void {
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id                   TEXT PRIMARY KEY,
      status               TEXT NOT NULL DEFAULT 'pending',
      prompt               TEXT NOT NULL,
      project_dir          TEXT NOT NULL,
      model                TEXT,
      max_turns            INTEGER,
      max_budget_usd       REAL,
      system_prompt        TEXT,
      append_system_prompt TEXT,
      permission_mode      TEXT DEFAULT 'bypassPermissions',
      allowed_tools        TEXT,
      disallowed_tools     TEXT,
      claude_md            TEXT,
      extra_env            TEXT,
      priority             INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      started_at           TEXT,
      finished_at          TEXT,
      exit_code            INTEGER,
      result_text          TEXT,
      transcript           TEXT,
      cost_usd             REAL,
      error                TEXT,
      duration_ms          INTEGER,
      worker_container     TEXT,
      worktree_path        TEXT,
      worktree_branch      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority, created_at);
  `);

  logger.info({ path: DB_PATH }, 'Database initialized');
}

/** Create a new job. Returns the job ID. */
export function createJob(input: CreateJobInput): string {
  const id = input.id || crypto.randomUUID();

  db.prepare(
    `
    INSERT INTO jobs (id, prompt, project_dir, model, max_turns, max_budget_usd,
      system_prompt, append_system_prompt, permission_mode,
      allowed_tools, disallowed_tools, claude_md, extra_env, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.prompt,
    input.project_dir,
    input.model ?? null,
    input.max_turns ?? null,
    input.max_budget_usd ?? null,
    input.system_prompt ?? null,
    input.append_system_prompt ?? null,
    input.permission_mode ?? 'bypassPermissions',
    input.allowed_tools ? JSON.stringify(input.allowed_tools) : null,
    input.disallowed_tools ? JSON.stringify(input.disallowed_tools) : null,
    input.claude_md ?? null,
    input.extra_env ? JSON.stringify(input.extra_env) : null,
    input.priority ?? 0,
  );

  return id;
}

/** Get a single job by ID. */
export function getJob(id: string): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
    | Job
    | undefined;
}

/** Claim the next pending job (atomically set status to running). */
export function claimNextJob(): Job | undefined {
  const job = db
    .prepare(
      `
    SELECT * FROM jobs
    WHERE status = 'pending'
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  `,
    )
    .get() as Job | undefined;

  if (!job) return undefined;

  db.prepare(
    `
    UPDATE jobs SET status = 'running', started_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `,
  ).run(job.id);

  return { ...job, status: 'running', started_at: new Date().toISOString() };
}

/** Mark a job as done with results. */
export function completeJob(
  id: string,
  result: {
    exit_code: number;
    result_text: string | null;
    transcript: string;
    cost_usd: number | null;
    duration_ms: number;
    worker_container: string;
    worktree_path: string | null;
    worktree_branch: string | null;
  },
): void {
  db.prepare(
    `
    UPDATE jobs SET
      status = 'done',
      finished_at = datetime('now'),
      exit_code = ?,
      result_text = ?,
      transcript = ?,
      cost_usd = ?,
      duration_ms = ?,
      worker_container = ?,
      worktree_path = ?,
      worktree_branch = ?
    WHERE id = ?
  `,
  ).run(
    result.exit_code,
    result.result_text,
    result.transcript,
    result.cost_usd,
    result.duration_ms,
    result.worker_container,
    result.worktree_path,
    result.worktree_branch,
    id,
  );
}

/** Mark a job as failed. */
export function failJob(
  id: string,
  error: string,
  duration_ms: number,
  worker_container?: string,
): void {
  db.prepare(
    `
    UPDATE jobs SET
      status = 'failed',
      finished_at = datetime('now'),
      error = ?,
      duration_ms = ?,
      worker_container = ?
    WHERE id = ?
  `,
  ).run(error, duration_ms, worker_container ?? null, id);
}

/** Count jobs by status. */
export function jobCounts(): Record<string, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) as count FROM jobs GROUP BY status')
    .all() as Array<{ status: string; count: number }>;

  const counts: Record<string, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
  };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

/** List jobs with optional status filter. */
export function listJobs(status?: string, limit = 50): Job[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(status, limit) as Job[];
  }
  return db
    .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Job[];
}

/** Reset stale running jobs back to pending (e.g., after orchestrator crash). */
export function resetStaleJobs(): number {
  const result = db
    .prepare(
      "UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running'",
    )
    .run();
  return result.changes;
}
```

## Key Design Decisions

1. **SQLite with WAL mode** — concurrent reads while one writer works. `better-sqlite3` is synchronous, which is fine since the orchestrator is single-threaded.

2. **`claimNextJob()` is atomic** — SELECT + UPDATE in sequence. Since `better-sqlite3` is synchronous and single-connection, there's no race condition. If you later want multi-process access, wrap in a transaction.

3. **Transcript stored as TEXT** — the full JSONL stream from `--output-format stream-json`. This can be large (megabytes for long sessions). If storage becomes a concern, write to a file and store the path instead.

4. **`claude_md` is the CONTENTS, not a path** — the caller passes the full text of the CLAUDE.md they want injected. The orchestrator writes it to the worktree before spawning the container. This avoids path-mapping complexity.

5. **`resetStaleJobs()` on startup** — if the orchestrator crashes, any `running` jobs are reset to `pending` so they get retried.
