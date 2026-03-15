import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { logger } from './logger.js';
import { startCredentialProxy, getLastRetryAfterSeconds } from './credential-proxy.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import {
  JOB_POLL_INTERVAL,
  MAX_CONCURRENT_WORKERS,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  WORKTREES_DIR,
} from './config.js';
import {
  initDb,
  claimNextJob,
  completeJob,
  failJob,
  requeueJob,
  resetStaleJobs,
  jobCounts,
  Job,
} from './db.js';
import {
  autoGrantProjectPermissions,
  grantJobPermissions,
} from './permissions.js';
import { runWorker, WorkerResult, isRetryableError, parseRetryAfterFromError } from './worker.js';

// ---------------------------------------------------------------------------
// Git worktree management
// ---------------------------------------------------------------------------

interface WorktreeInfo {
  path: string;
  branch: string;
}

function createWorktree(projectDir: string, jobId: string, suffix: string): WorktreeInfo | null {
  try {
    execSync('git rev-parse --git-dir', { cwd: projectDir, stdio: 'pipe' });
  } catch {
    logger.warn({ projectDir, jobId }, 'Not a git repo — running in project dir directly');
    return null;
  }

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const worktreePath = path.join(WORKTREES_DIR, `${jobId}-${suffix}`);
  const branch = `worker/${jobId}-${suffix}`;

  try {
    execSync(
      `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)}`,
      { cwd: projectDir, stdio: 'pipe' },
    );
    logger.info({ jobId, worktreePath, branch }, 'Created worktree');
    return { path: worktreePath, branch };
  } catch (err) {
    logger.error({ jobId, err }, 'Failed to create worktree');
    return null;
  }
}

function removeWorktree(projectDir: string, wt: WorktreeInfo): void {
  try {
    execSync(`git worktree remove --force ${JSON.stringify(wt.path)}`, {
      cwd: projectDir, stdio: 'pipe',
    });
  } catch { /* best effort */ }
  try {
    execSync(`git branch -D ${JSON.stringify(wt.branch)}`, {
      cwd: projectDir, stdio: 'pipe',
    });
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Host path translation (when orchestrator runs in Docker)
// ---------------------------------------------------------------------------

function toHostPath(containerPath: string): string {
  const hostWorktrees = process.env.HOST_WORKTREES_DIR;
  if (!hostWorktrees || hostWorktrees === WORKTREES_DIR) return containerPath;
  if (containerPath.startsWith(WORKTREES_DIR)) {
    return hostWorktrees + containerPath.slice(WORKTREES_DIR.length);
  }
  return containerPath;
}

// ---------------------------------------------------------------------------
// Job dispatch
// ---------------------------------------------------------------------------

async function dispatchJob(job: Job): Promise<void> {
  const startTime = Date.now();
  const suffix = crypto.randomBytes(4).toString('hex');

  logger.info({ jobId: job.id, project: job.project_dir, priority: job.priority }, 'Dispatching job');

  // Grant permissions: project defaults + explicit job-level grants
  autoGrantProjectPermissions(job.id, job.project_dir);
  if (job.permissions) {
    try {
      const perms = JSON.parse(job.permissions) as Array<{ token_name: string; can_delegate?: boolean; duration_minutes?: number }>;
      grantJobPermissions(job.id, perms);
    } catch {
      logger.warn({ jobId: job.id }, 'Invalid permissions JSON — skipping job-level grants');
    }
  }

  const worktree = createWorktree(job.project_dir, job.id, suffix);
  const workDir = worktree?.path ?? job.project_dir;

  if (job.claude_md) {
    fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), job.claude_md);
  }

  try {
    const result: WorkerResult = await runWorker({
      jobId: job.id,
      jobToken: job.job_token!,
      suffix,
      prompt: job.prompt,
      workDir,
      hostWorkDir: worktree ? toHostPath(worktree.path) : job.project_dir,
      model: job.model ?? undefined,
      maxTurns: job.max_turns ?? undefined,
      maxBudgetUsd: job.max_budget_usd ?? undefined,
      systemPrompt: job.system_prompt ?? undefined,
      appendSystemPrompt: job.append_system_prompt ?? undefined,
      permissionMode: job.permission_mode,
      allowedTools: job.allowed_tools ? JSON.parse(job.allowed_tools) : undefined,
      disallowedTools: job.disallowed_tools ? JSON.parse(job.disallowed_tools) : undefined,
      extraEnv: job.extra_env ? JSON.parse(job.extra_env) : undefined,
    });

    const durationMs = Date.now() - startTime;

    if (result.status === 'success') {
      completeJob(job.id, {
        exit_code: result.exitCode,
        result_text: result.resultText,
        transcript: result.transcript,
        cost_usd: result.costUsd,
        duration_ms: durationMs,
        worker_container: result.containerName,
        worktree_path: worktree?.path ?? null,
        worktree_branch: worktree?.branch ?? null,
      });
      logger.info(
        { jobId: job.id, durationMs, costUsd: result.costUsd },
        'Job completed successfully',
      );
    } else {
      const error = result.error ?? 'Unknown error';
      const retryCount = (job.retry_count ?? 0) + 1;

      if (isRetryableError(error) && retryCount <= MAX_RETRIES) {
        let delayMs: number;
        const fromError = parseRetryAfterFromError(error);
        const fromProxy = getLastRetryAfterSeconds();
        if (fromError != null && fromError > 0) {
          delayMs = fromError * 1000;
          logger.warn(
            { jobId: job.id, retryCount, maxRetries: MAX_RETRIES, delayMs, source: 'error' },
            'Retryable error — requeued using retry-after from API response',
          );
        } else if (fromProxy != null && fromProxy > 0) {
          delayMs = fromProxy * 1000;
          logger.warn(
            { jobId: job.id, retryCount, maxRetries: MAX_RETRIES, delayMs, source: 'proxy' },
            'Retryable error — requeued using retry-after from API response',
          );
        } else {
          delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, retryCount - 1);
          logger.warn(
            { jobId: job.id, retryCount, maxRetries: MAX_RETRIES, delayMs, source: 'backoff' },
            'Retryable error — requeued with exponential backoff (no retry-after from API)',
          );
        }
        requeueJob(job.id, retryCount, delayMs);
      } else {
        failJob(job.id, error, durationMs, result.containerName);
        if (isRetryableError(error)) {
          logger.error(
            { jobId: job.id, retryCount, maxRetries: MAX_RETRIES, error, durationMs },
            'Job failed — max retries exhausted',
          );
        } else {
          logger.error({ jobId: job.id, error, durationMs }, 'Job failed — not retryable');
        }
      }
      if (worktree) removeWorktree(job.project_dir, worktree);
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    failJob(job.id, errMsg, durationMs);
    logger.error({ jobId: job.id, err }, 'Job dispatch error');
    if (worktree) removeWorktree(job.project_dir, worktree);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('macro-claw orchestrator starting');

  initDb();
  const staleCount = resetStaleJobs();
  if (staleCount > 0) {
    logger.warn({ count: staleCount }, 'Failed stale running jobs from previous run');
  }

  // Skip Docker check in local mode (CLAUDE_BINARY override)
  if (!process.env.CLAUDE_BINARY) {
    ensureContainerRuntimeRunning();
    cleanupOrphans();
  }

  // Start credential proxy
  const proxyPort = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
  const proxyHost = process.env.CREDENTIAL_PROXY_HOST || '127.0.0.1';
  await startCredentialProxy(proxyPort, proxyHost);
  logger.info({ port: proxyPort, host: proxyHost }, 'Credential proxy started');

  const counts = jobCounts();
  logger.info(
    { maxConcurrent: MAX_CONCURRENT_WORKERS, pollInterval: JOB_POLL_INTERVAL, ...counts },
    'Orchestrator ready — polling for jobs',
  );

  const activeJobs = new Set<string>();

  const poll = async () => {
    try {
      while (activeJobs.size < MAX_CONCURRENT_WORKERS) {
        const job = claimNextJob();
        if (!job) break;

        activeJobs.add(job.id);
        dispatchJob(job)
          .finally(() => activeJobs.delete(job.id));
      }
    } catch (err) {
      logger.error({ err }, 'Poll error');
    }
  };

  await poll();
  setInterval(poll, JOB_POLL_INTERVAL);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal orchestrator error');
  process.exit(1);
});
