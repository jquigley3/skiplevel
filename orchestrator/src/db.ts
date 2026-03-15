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
  allowed_tools: string | null;    // JSON array string
  disallowed_tools: string | null; // JSON array string
  claude_md: string | null;
  extra_env: string | null;        // JSON object string
  capabilities: string | null;    // JSON array string, e.g. '["spawn_task"]'
  job_token: string | null;       // random secret, set at claim time
  parent_job_id: string | null;
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
  id?: string;
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
  capabilities?: string[];
  parent_job_id?: string;
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
      capabilities         TEXT,
      job_token            TEXT,
      parent_job_id        TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_token ON jobs(job_token);
  `);

  // Migrate: add columns that may not exist in older databases
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const migrations: Array<[string, string]> = [
    ['capabilities', 'TEXT'],
    ['job_token', 'TEXT'],
    ['parent_job_id', 'TEXT'],
  ];
  for (const [col, type] of migrations) {
    if (!colNames.has(col)) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${type}`);
      logger.info({ column: col }, 'Migrated jobs table — added column');
    }
  }

  logger.info({ path: DB_PATH }, 'Database initialized');
}

/** Create a new job. Returns the job ID. */
export function createJob(input: CreateJobInput): string {
  const id = input.id || crypto.randomUUID();

  db.prepare(`
    INSERT INTO jobs (id, prompt, project_dir, model, max_turns, max_budget_usd,
      system_prompt, append_system_prompt, permission_mode,
      allowed_tools, disallowed_tools, claude_md, extra_env,
      capabilities, parent_job_id, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
    input.capabilities ? JSON.stringify(input.capabilities) : null,
    input.parent_job_id ?? null,
    input.priority ?? 0,
  );

  return id;
}

/** Get a single job by ID. */
export function getJob(id: string): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
}

/** Claim the next pending job (atomically set status to running, generate job_token). */
export function claimNextJob(): Job | undefined {
  const job = db.prepare(`
    SELECT * FROM jobs
    WHERE status = 'pending'
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  `).get() as Job | undefined;

  if (!job) return undefined;

  const token = crypto.randomUUID();

  db.prepare(`
    UPDATE jobs SET status = 'running', started_at = datetime('now'), job_token = ?
    WHERE id = ? AND status = 'pending'
  `).run(token, job.id);

  return { ...job, status: 'running', started_at: new Date().toISOString(), job_token: token };
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
  db.prepare(`
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
  `).run(
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
  db.prepare(`
    UPDATE jobs SET
      status = 'failed',
      finished_at = datetime('now'),
      error = ?,
      duration_ms = ?,
      worker_container = ?
    WHERE id = ?
  `).run(error, duration_ms, worker_container ?? null, id);
}

/** Count jobs by status. */
export function jobCounts(): Record<string, number> {
  const rows = db.prepare(
    "SELECT status, COUNT(*) as count FROM jobs GROUP BY status"
  ).all() as Array<{ status: string; count: number }>;

  const counts: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

/** List jobs with optional status filter. */
export function listJobs(status?: string, limit = 50): Job[] {
  if (status) {
    return db.prepare(
      'SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?'
    ).all(status, limit) as Job[];
  }
  return db.prepare(
    'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as Job[];
}

/** Reset stale running jobs back to pending (e.g., after orchestrator crash). */
export function resetStaleJobs(): number {
  const result = db.prepare(
    "UPDATE jobs SET status = 'pending', started_at = NULL, job_token = NULL WHERE status = 'running'"
  ).run();
  return result.changes;
}

/** Look up a running job by its token (for capability API auth). */
export function getJobByToken(token: string): Job | undefined {
  return db.prepare(
    "SELECT * FROM jobs WHERE job_token = ? AND status = 'running'"
  ).get(token) as Job | undefined;
}

/** List child jobs of a given parent. */
export function listChildJobs(parentId: string): Job[] {
  return db.prepare(
    'SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY created_at ASC'
  ).all(parentId) as Job[];
}
