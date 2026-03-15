import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Must be set before the db module is imported so DB_PATH config is correct
process.env.DB_PATH = path.join(os.tmpdir(), `macro-claw-test-${Date.now()}.db`);

// Lazy-loaded after env is set
let db: typeof import('../src/db.js');

const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-claw-test-project-'));

before(async () => {
  execSync('git init', { cwd: tmpProjectDir, stdio: 'pipe' });
  execSync('git config user.name "test"', { cwd: tmpProjectDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tmpProjectDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(tmpProjectDir, 'README.md'), '# Test Project\n');
  execSync('git add -A && git commit -m "init"', { cwd: tmpProjectDir, stdio: 'pipe' });

  db = await import('../src/db.js');
  db.initDb();
});

after(() => {
  try { fs.rmSync(tmpProjectDir, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(process.env.DB_PATH!); } catch {}
});

test('create and retrieve a job', () => {
  const jobId = db.createJob({
    prompt: 'Say hello',
    project_dir: tmpProjectDir,
    priority: 0,
  });

  const job = db.getJob(jobId);
  assert.ok(job, 'Job should exist');
  assert.strictEqual(job!.status, 'pending');
  assert.strictEqual(job!.prompt, 'Say hello');
  assert.strictEqual(job!.project_dir, tmpProjectDir);
});

test('claimNextJob atomically moves pending to running', () => {
  db.createJob({ prompt: 'Claim test', project_dir: tmpProjectDir, priority: 0 });

  const claimed = db.claimNextJob();
  assert.ok(claimed, 'Should claim a job');
  assert.strictEqual(claimed!.status, 'running');

  const job = db.getJob(claimed!.id);
  assert.strictEqual(job!.status, 'running');

  db.completeJob(claimed!.id, {
    exit_code: 0,
    result_text: 'done',
    transcript: '',
    cost_usd: 0,
    duration_ms: 100,
    worker_container: 'test',
    worktree_path: null,
    worktree_branch: null,
  });
});

test('resetStaleJobs moves running back to pending', () => {
  const jobId = db.createJob({ prompt: 'Test stale job', project_dir: tmpProjectDir });

  // Simulate orchestrator crash: manually set to running
  const rawDb = new Database(process.env.DB_PATH!);
  rawDb.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  rawDb.close();

  const count = db.resetStaleJobs();
  assert.ok(count >= 1, 'Should reset at least 1 stale job');

  const job = db.getJob(jobId);
  assert.strictEqual(job!.status, 'pending');
});

test('completeJob stores result fields', () => {
  db.createJob({ prompt: 'Complete test', project_dir: tmpProjectDir });
  const claimed = db.claimNextJob();
  assert.ok(claimed);

  db.completeJob(claimed!.id, {
    exit_code: 0,
    result_text: 'All done.',
    transcript: '{"type":"result","result":"All done."}',
    cost_usd: 0.0042,
    duration_ms: 1234,
    worker_container: 'macro-claw-testjob-ab12',
    worktree_path: '/tmp/worktree',
    worktree_branch: 'worker/testjob-ab12',
  });

  const job = db.getJob(claimed!.id);
  assert.strictEqual(job!.status, 'done');
  assert.strictEqual(job!.result_text, 'All done.');
  assert.strictEqual(job!.cost_usd, 0.0042);
  assert.strictEqual(job!.worktree_branch, 'worker/testjob-ab12');
});

test('failJob stores error', () => {
  db.createJob({ prompt: 'Fail test', project_dir: tmpProjectDir });
  const claimed = db.claimNextJob();
  assert.ok(claimed);

  db.failJob(claimed!.id, 'Container exited with code 1', 500, 'macro-claw-fail');

  const job = db.getJob(claimed!.id);
  assert.strictEqual(job!.status, 'failed');
  assert.ok(job!.error!.includes('Container exited'));
});

test('jobCounts returns correct counts', () => {
  const counts = db.jobCounts();
  assert.ok(typeof counts.pending === 'number');
  assert.ok(typeof counts.running === 'number');
  assert.ok(typeof counts.done === 'number');
  assert.ok(typeof counts.failed === 'number');
});

test('claimNextJob generates a job_token', () => {
  db.createJob({ prompt: 'Token test', project_dir: tmpProjectDir });
  const claimed = db.claimNextJob();
  assert.ok(claimed);
  assert.ok(claimed!.job_token, 'Claimed job should have a token');
  assert.ok(claimed!.job_token!.length > 10, 'Token should be a UUID');

  db.completeJob(claimed!.id, {
    exit_code: 0, result_text: null, transcript: '', cost_usd: null,
    duration_ms: 0, worker_container: 'test', worktree_path: null, worktree_branch: null,
  });
});

test('getJobByToken returns a running job', () => {
  db.createJob({ prompt: 'Token lookup test', project_dir: tmpProjectDir });
  const claimed = db.claimNextJob();
  assert.ok(claimed);

  const found = db.getJobByToken(claimed!.job_token!);
  assert.ok(found, 'Should find job by token');
  assert.strictEqual(found!.id, claimed!.id);

  assert.strictEqual(db.getJobByToken('bogus-token'), undefined);

  db.completeJob(claimed!.id, {
    exit_code: 0, result_text: null, transcript: '', cost_usd: null,
    duration_ms: 0, worker_container: 'test', worktree_path: null, worktree_branch: null,
  });

  assert.strictEqual(db.getJobByToken(claimed!.job_token!), undefined,
    'Token should not resolve once job is done');
});

test('createJob with capabilities and parent_job_id', () => {
  const parentId = db.createJob({
    prompt: 'Parent job',
    project_dir: tmpProjectDir,
    capabilities: ['spawn_task'],
  });

  const parent = db.getJob(parentId);
  assert.ok(parent);
  assert.strictEqual(parent!.capabilities, '["spawn_task"]');

  const childId = db.createJob({
    prompt: 'Child job',
    project_dir: tmpProjectDir,
    parent_job_id: parentId,
  });

  const child = db.getJob(childId);
  assert.ok(child);
  assert.strictEqual(child!.parent_job_id, parentId);

  const children = db.listChildJobs(parentId);
  assert.strictEqual(children.length, 1);
  assert.strictEqual(children[0].id, childId);
});
