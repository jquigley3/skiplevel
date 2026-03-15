/**
 * Integration test: new-user first-task flow
 *
 * Validates the orchestrator's core loop without Docker, credentials, or
 * external services. A fake-agent script stands in for the Claude CLI.
 *
 * Flow: temp project dir → task YAML (status: assigned) → orchestrator starts
 *       → fake-agent runs → task reaches status: review
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const ORCHESTRATOR_DIR = path.join(REPO_ROOT, 'orchestrator');
const FAKE_AGENT = path.join(REPO_ROOT, 'scripts', 'fake-agent.sh');

// Temp dirs live inside the repo so git worktree creation works
// (the orchestrator uses git worktrees; they require a parent git repo).
const TMP_BASE = path.join(REPO_ROOT, 'test', 'tmp');

function readStatus(taskPath: string): string {
  const yaml = fs.readFileSync(taskPath, 'utf8');
  return (yaml.match(/^status:\s*(\S+)/m) ?? [])[1] ?? '';
}

function findResultMd(projectsDir: string): string | null {
  // result.md lands in the worktree: <projectsDir>/worktrees/<id>/ipc/result.md
  const worktreesDir = path.join(projectsDir, 'worktrees');
  if (!fs.existsSync(worktreesDir)) return null;
  for (const entry of fs.readdirSync(worktreesDir)) {
    const p = path.join(worktreesDir, entry, 'ipc', 'result.md');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

test(
  'first-task: task reaches review status',
  { timeout: 30_000 },
  async () => {
    fs.mkdirSync(TMP_BASE, { recursive: true });
    const projectsDir = fs.mkdtempSync(path.join(TMP_BASE, 'harness-'));

    // Minimal project structure
    const projectDir = path.join(projectsDir, 'smoke');
    const tasksDir = path.join(projectDir, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'ipc'), { recursive: true });

    const taskPath = path.join(tasksDir, 'TEST-001.yaml');
    fs.writeFileSync(
      taskPath,
      [
        'id: TEST-001',
        'title: "Fake agent smoke test"',
        'description: Write a confirmation to ipc/result.md.',
        'status: assigned',
        'priority: P1',
        'assignee: sub-agent',
        'deliverables:',
        '  - ipc/result.md',
        'agent_spec:',
        '  isolation: local',
        `  claude_binary: "${FAKE_AGENT}"`,
      ].join('\n') + '\n',
    );

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PROJECTS_DIR: projectsDir,
      HOST_PROJECTS_DIR: projectsDir,
      PKB_DIR: '/dev/null',
      HOST_PKB_DIR: '/dev/null',
      TASK_POLL_INTERVAL: '500',
      CONTAINER_IMAGE: 'none',
      LOG_LEVEL: 'warn',
    };

    let orchestrator: ChildProcess | undefined;
    try {
      orchestrator = spawn('npx', ['tsx', 'src/orchestrator.ts'], {
        cwd: ORCHESTRATOR_DIR,
        env,
        stdio: 'pipe',
      });

      // Surface orchestrator stderr on failure
      const stderrChunks: Buffer[] = [];
      orchestrator.stderr?.on('data', (chunk: Buffer) =>
        stderrChunks.push(chunk),
      );

      // Poll for task to reach review (up to 25s)
      const deadline = Date.now() + 25_000;
      let status = '';
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        status = readStatus(taskPath);
        if (status === 'review') break;
      }

      if (status !== 'review') {
        const stderr = Buffer.concat(stderrChunks).toString().slice(-1000);
        assert.fail(
          `Task did not reach review within timeout. Last status: "${status}"\nOrchestrator stderr:\n${stderr}`,
        );
      }

      assert.equal(status, 'review');
      assert.ok(
        findResultMd(projectsDir) !== null,
        'ipc/result.md should exist in worktree',
      );
      assert.equal(
        orchestrator.exitCode,
        null,
        'Orchestrator should still be running',
      );
    } finally {
      orchestrator?.kill();
      fs.rmSync(projectsDir, { recursive: true, force: true });
    }
  },
);
