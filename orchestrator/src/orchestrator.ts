/**
 * Agent Harness Orchestrator
 *
 * Watches project task directories for tasks with status=assigned,
 * dispatches them to Docker sub-agents, collects results, updates state.
 *
 * Runs as a persistent process (in Docker with docker.sock).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';

import { logger } from './logger.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  CONTAINER_RUNTIME_BIN,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  MAX_CONCURRENT_CONTAINERS,
  PROJECTS_DIR,
  PROXY_STATS_URL,
  TASK_POLL_INTERVAL,
} from './config.js';
import { loadTaskFile, updateTaskStatus, TaskFile } from './task-loader.js';
import { resolveSessionConfig, SessionBuilder } from './session-builder.js';
import { WorktreeInfo } from './session-spec.js';

/** Scan all projects for tasks with status=assigned */
function findAssignedTasks(): TaskFile[] {
  const tasks: TaskFile[] = [];

  if (!fs.existsSync(PROJECTS_DIR)) return tasks;

  // Collect candidate project directories.
  // Two layouts are supported:
  //   A) Multi-project:  PROJECTS_DIR/<project>/tasks/*.yaml  (standard)
  //   B) Single-project: PROJECTS_DIR/tasks/*.yaml            (repo-as-project)
  const projectDirs: Array<{ name: string; dir: string }> = [];

  // Layout B — PROJECTS_DIR itself has a tasks/ subdir
  if (fs.existsSync(path.join(PROJECTS_DIR, 'tasks'))) {
    projectDirs.push({ name: path.basename(PROJECTS_DIR), dir: PROJECTS_DIR });
  }

  // Layout A — each subdirectory of PROJECTS_DIR that has a tasks/ subdir
  for (const entry of fs.readdirSync(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (entry === 'tasks' || entry === 'worktrees') continue; // skip reserved names
    if (fs.existsSync(path.join(dir, 'tasks'))) {
      projectDirs.push({ name: entry, dir });
    }
  }

  for (const { name: project, dir: projectDir } of projectDirs) {
    const tasksDir = path.join(projectDir, 'tasks');
    if (!fs.statSync(tasksDir).isDirectory()) continue;

    for (const file of fs.readdirSync(tasksDir)) {
      if (!file.endsWith('.yaml')) continue;
      const filePath = path.join(tasksDir, file);
      const task = loadTaskFile(filePath);
      if (task?.status === 'assigned') {
        task.project = project;
        task.projectDir = projectDir;
        task.filePath = filePath;
        tasks.push(task);
      }
    }
  }

  // Sort by priority (P0 first)
  tasks.sort((a, b) => a.priority.localeCompare(b.priority));
  return tasks;
}

/** Write the IPC task.md for a sub-agent */
function writeIpcTask(projectDir: string, task: TaskFile): void {
  const ipcDir = path.join(projectDir, 'ipc');
  fs.mkdirSync(ipcDir, { recursive: true });

  const deliverablesList = task.deliverables?.length
    ? task.deliverables.map((d) => `- ${d}`).join('\n')
    : '- /workspace/project/ipc/result.md';

  const taskContent = `# Task: ${task.id} — ${task.title}

Priority: ${task.priority}

## Description
${task.description}

## Deliverables
${deliverablesList}

## Instructions
1. Read project context: README.md, CLAUDE.md, relevant notes/
2. Execute the task described above
3. Write progress to /workspace/project/ipc/status.md as you work
4. When done, write a summary to /workspace/project/ipc/result.md

## Scope
- Only modify files in /workspace/project/
- Do NOT modify anything in /workspace/pkb/ (read-only)
- Do NOT run docker commands — container lifecycle is managed by the orchestrator
- Write IPC files to /workspace/project/ipc/

## Git Logging
Commit your work as you go. Commit messages are the audit trail — explain
your reasoning, not just what changed. Keep ipc/ out of commits (ephemeral).

Pattern:
1. Initial commit: note your plan/approach before making changes
2. Each meaningful change: commit with why (not just what)
3. Final commit: summarize outcome and any open questions
`;

  fs.writeFileSync(path.join(ipcDir, 'task.md'), taskContent);

  // Clean previous results
  for (const f of ['status.md', 'result.md']) {
    const p = path.join(ipcDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

/** Return recent git log --oneline for a project directory (best-effort) */
function gitLogSummary(projectDir: string, n = 10): string {
  try {
    execSync('git rev-parse --git-dir', { cwd: projectDir, stdio: 'pipe' });
    return execSync(`git log --oneline -${n}`, {
      cwd: projectDir,
      stdio: 'pipe',
    })
      .toString()
      .trim();
  } catch {
    return '(no git history)';
  }
}

/** Check whether a directory is inside a git repo */
function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a git worktree for a task.
 *
 * Creates the worktree at `<projectsDir>/../worktrees/<taskId>-<suffix>` on a new
 * branch `agent/<taskId>-<suffix>`. The suffix (from the container name) ensures
 * retries never collide with stale branches from prior attempts.
 *
 * Returns a WorktreeInfo with path and branch, or null if not a git repo.
 */
function createWorktree(
  projectDir: string,
  taskId: string,
  suffix: string,
): WorktreeInfo | null {
  if (!isGitRepo(projectDir)) {
    logger.warn(
      { projectDir, taskId },
      'Project has no git repo — skipping worktree, using project dir directly',
    );
    return null;
  }

  // Worktrees live as siblings to projects, inside the mounted projects volume.
  // Must stay within PROJECTS_DIR so the orchestrator container can see the files.
  const worktreesRoot = path.join(path.dirname(projectDir), 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });

  const worktreePath = path.join(worktreesRoot, `${taskId}-${suffix}`);
  const branch = `agent/${taskId}-${suffix}`;

  try {
    execSync(
      `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)}`,
      { cwd: projectDir, stdio: 'pipe' },
    );
    logger.info({ taskId, worktreePath, branch }, 'Created git worktree');
    return { path: worktreePath, branch };
  } catch (err) {
    logger.error(
      { taskId, worktreePath, err },
      'Failed to create worktree — falling back to project dir',
    );
    return null;
  }
}

/**
 * Remove a git worktree created by createWorktree.
 *
 * Also deletes the branch. Best-effort — never throws.
 */
function removeWorktree(projectDir: string, worktree: WorktreeInfo): void {
  try {
    if (!fs.existsSync(worktree.path)) return;
    execSync(`git worktree remove --force ${JSON.stringify(worktree.path)}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
    logger.info({ worktreePath: worktree.path }, 'Removed git worktree');
  } catch (err) {
    logger.warn(
      { worktreePath: worktree.path, err },
      'Failed to remove worktree',
    );
  }

  // Remove the branch — ignore errors (branch may not exist or was already cleaned up)
  try {
    execSync(`git branch -D ${JSON.stringify(worktree.branch)}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
    logger.info({ branch: worktree.branch }, 'Deleted worktree branch');
  } catch {
    // Not an error
  }
}

/** Git commit in a project directory (best-effort, never throws) */
function gitCommit(projectDir: string, message: string): void {
  try {
    // Ensure repo exists — init if not
    try {
      execSync('git rev-parse --git-dir', { cwd: projectDir, stdio: 'pipe' });
    } catch {
      execSync('git init', { cwd: projectDir, stdio: 'pipe' });
      execSync(
        'git config user.name "agent-harness" && git config user.email "orchestrator@agent-harness.local"',
        { cwd: projectDir, stdio: 'pipe' },
      );
      logger.info({ projectDir }, 'Initialized git repo');
    }
    // Stage all changes (except ipc/ which is in .gitignore)
    execSync('git add -A', { cwd: projectDir, stdio: 'pipe' });
    // Only commit if there are staged changes
    execSync(`git diff --cached --quiet`, { cwd: projectDir, stdio: 'pipe' });
    // If we get here, there's nothing to commit
  } catch {
    // Either no git repo (skip) or there ARE staged changes (commit)
    try {
      execSync('git rev-parse --git-dir', { cwd: projectDir, stdio: 'pipe' });
      execSync(
        `git commit -m ${JSON.stringify(message)} --author="agent-harness <orchestrator@agent-harness.local>"`,
        { cwd: projectDir, stdio: 'pipe' },
      );
      logger.info({ projectDir }, `Git commit: ${message.split('\n')[0]}`);
    } catch {
      // No git repo or commit failed — that's fine
    }
  }
}

/** Fetch proxy stats — returns null if proxy is unavailable (best-effort) */
async function fetchProxyStats(): Promise<Record<string, unknown> | null> {
  if (!PROXY_STATS_URL) return null;
  try {
    const res = await fetch(`${PROXY_STATS_URL}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Spawn a sub-agent for a task. Returns true on success, false on failure. */
async function dispatchTask(task: TaskFile): Promise<boolean> {
  const projectDir = task.projectDir;
  const suffix = crypto.randomBytes(4).toString('hex');

  const proxyStats = await fetchProxyStats();

  updateTaskStatus(task.filePath, 'in-progress', 'sub-agent');

  const worktree = createWorktree(projectDir, task.id, suffix);
  const workDir = worktree?.path ?? projectDir;

  writeIpcTask(workDir, task);
  gitCommit(
    projectDir,
    `[orchestrator] Dispatch ${task.id}: ${task.title}\n\nPriority: ${task.priority}\nWorktree: ${worktree?.path ?? 'none (fallback)'}`,
  );

  // Build the spawn spec via SessionBuilder
  const sessionConfig = resolveSessionConfig(task, worktree, suffix);
  const spawnSpec = new SessionBuilder().build(sessionConfig);

  logger.info(
    {
      task: task.id,
      project: task.project,
      isolation: sessionConfig.isolation,
      containerName: spawnSpec.containerName,
      proxyStats,
    },
    'Dispatching task to sub-agent',
  );

  return new Promise<boolean>((resolve) => {
    const [bin, ...args] = spawnSpec.command;
    const container = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: spawnSpec.workdir,
      env: spawnSpec.env,
    });

    let stderr = '';

    // Parse stream-json events from Claude and log them readably.
    // stream-json emits one JSON object per line for each event (text, tool calls, etc.)
    function logStreamJsonLine(line: string): void {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const type = event.type as string;
        if (type === 'assistant') {
          const msg = event.message as Record<string, unknown>;
          const content = msg?.content as Array<Record<string, unknown>>;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                const text = (block.text as string).trim();
                for (const textLine of text.split('\n')) {
                  if (textLine.trim())
                    process.stdout.write(`[${task.id}] [text] ${textLine}\n`);
                }
              } else if (block.type === 'tool_use') {
                const input = JSON.stringify(block.input).slice(0, 300);
                process.stdout.write(
                  `[${task.id}] [tool:${block.name}] ${input}\n`,
                );
              }
            }
          }
        } else if (type === 'tool_result') {
          // Skip tool results — they're verbose and already logged via tool_use
        } else if (type === 'result') {
          const cost =
            typeof event.total_cost_usd === 'number'
              ? `$${(event.total_cost_usd as number).toFixed(4)}`
              : 'unknown';
          process.stdout.write(
            `[${task.id}] [result] cost=${cost} is_error=${event.is_error}\n`,
          );
        } else if (type === 'system') {
          const sub = (event as Record<string, unknown>).subtype as string;
          if (sub === 'init') {
            process.stdout.write(`[${task.id}] [start] model=${event.model}\n`);
          }
        }
      } catch {
        // Not JSON — log as-is (e.g. startup messages from entrypoint)
        process.stdout.write(`[${task.id}] ${line}\n`);
      }
    }

    // Stream sub-agent output directly to orchestrator stdout/stderr so it
    // appears in `docker logs` in real time. Prefix each line with the task ID
    // so output is attributable when multiple tasks run concurrently.
    container.stdout.on('data', (data) => {
      for (const line of (data as Buffer).toString().split('\n')) {
        logStreamJsonLine(line);
      }
    });
    container.stderr.on('data', (data) => {
      const chunk = (data as Buffer).toString();
      stderr += chunk;
      for (const line of chunk.trim().split('\n')) {
        if (line) process.stderr.write(`[${task.id}] ${line}\n`);
      }
    });

    const timeout = setTimeout(() => {
      logger.error(
        { task: task.id, containerName: spawnSpec.containerName },
        'Task timeout, stopping',
      );
      if (spawnSpec.containerName) {
        try {
          execSync(`${CONTAINER_RUNTIME_BIN} stop ${spawnSpec.containerName}`, {
            timeout: 15000,
          });
        } catch {
          container.kill('SIGTERM');
        }
      } else {
        container.kill('SIGTERM');
      }
    }, spawnSpec.timeout_ms);

    container.on('close', (code) => {
      clearTimeout(timeout);

      // Check for result file in the ipcDir written by the sub-agent
      const resultPath = path.join(sessionConfig.ipcDir, 'result.md');
      const hasResult = fs.existsSync(resultPath);

      if (code === 0 && hasResult) {
        updateTaskStatus(task.filePath, 'review');
        // Git: record successful completion in the project repo
        gitCommit(
          projectDir,
          `[orchestrator] Complete ${task.id}: ${task.title}\n\nStatus: review\nExit code: ${code}\nWorktree branch: ${worktree?.branch ?? 'none'}`,
        );
        const recentLog = gitLogSummary(projectDir);
        logger.info(
          {
            task: task.id,
            project: task.project,
            worktree: worktree?.path,
            recentLog,
          },
          'Task completed, moved to review. Worktree preserved for merge.',
        );
        // Note: worktree is NOT removed here — the reviewer/user merges the branch
        // into main and then removes it manually.
        resolve(true);
      } else {
        updateTaskStatus(task.filePath, 'assigned'); // back to queue
        // Git: record failure
        gitCommit(
          projectDir,
          `[orchestrator] Failed ${task.id}: ${task.title}\n\nExit code: ${code}\nHas result: ${hasResult}\nReturned to queue`,
        );
        const recentLog = gitLogSummary(projectDir);
        logger.error(
          {
            task: task.id,
            code,
            hasResult,
            stderr: stderr.slice(-500),
            recentLog,
          },
          'Task failed, returning to queue',
        );
        // Clean up the worktree on failure so stale branches don't accumulate
        if (worktree) removeWorktree(projectDir, worktree);
        resolve(false);
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      updateTaskStatus(task.filePath, 'assigned');
      logger.error({ task: task.id, err }, 'Container spawn error');
      if (worktree) removeWorktree(projectDir, worktree);
      resolve(false);
    });
  });
}

/** Main orchestrator loop */
async function main(): Promise<void> {
  logger.info('Agent Harness Orchestrator starting');

  // Verify Docker (required for docker/apple-container isolation strategies)
  ensureContainerRuntimeRunning();
  logger.info('Container runtime OK');

  // Start credential proxy — bind to 0.0.0.0 so sibling containers can reach it via port mapping
  const credentialProxyPort = parseInt(
    process.env.CREDENTIAL_PROXY_PORT || '3001',
    10,
  );
  const proxyHost = process.env.CREDENTIAL_PROXY_HOST || '0.0.0.0';
  await startCredentialProxy(credentialProxyPort, proxyHost);
  logger.info(
    { port: credentialProxyPort, host: proxyHost },
    'Credential proxy started',
  );

  logger.info(
    {
      projects: PROJECTS_DIR,
      maxConcurrent: MAX_CONCURRENT_CONTAINERS,
      pollInterval: TASK_POLL_INTERVAL,
    },
    'Orchestrator ready — watching for tasks',
  );

  // Poll loop
  const activeTasks = new Set<string>();
  const failureCounts = new Map<string, number>();
  const MAX_RETRIES = 2;

  const poll = async () => {
    try {
      const tasks = findAssignedTasks();
      for (const task of tasks) {
        if (activeTasks.size >= MAX_CONCURRENT_CONTAINERS) break;
        if (activeTasks.has(task.id)) continue;

        const failures = failureCounts.get(task.id) || 0;
        if (failures >= MAX_RETRIES) {
          // Don't retry — mark as backlog so it doesn't keep failing
          logger.warn(
            { task: task.id, failures },
            'Task exceeded retry limit, moving to backlog',
          );
          updateTaskStatus(task.filePath, 'backlog');
          failureCounts.delete(task.id);
          continue;
        }

        activeTasks.add(task.id);
        dispatchTask(task)
          .then((success) => {
            if (success) {
              failureCounts.delete(task.id);
            } else {
              failureCounts.set(task.id, (failureCounts.get(task.id) || 0) + 1);
            }
          })
          .catch(() =>
            failureCounts.set(task.id, (failureCounts.get(task.id) || 0) + 1),
          )
          .finally(() => activeTasks.delete(task.id));
      }
    } catch (err) {
      logger.error({ err }, 'Poll error');
    }
  };

  // Initial poll
  await poll();
  // Continuous polling
  setInterval(poll, TASK_POLL_INTERVAL);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal orchestrator error');
  process.exit(1);
});
