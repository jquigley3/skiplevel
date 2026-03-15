# 08 — Testing

## Integration Test Strategy

The orchestrator can be tested end-to-end without real API credentials by substituting a fake agent script for the Claude CLI binary. This is the same approach used in nano-claw.

## Fake Agent Script

`test/fake-agent.sh` — a shell script that pretends to be Claude Code. It reads stdin, writes stream-json events to stdout, and exits 0.

```bash
#!/usr/bin/env bash
# Fake Claude Code CLI for testing.
# Emits minimal stream-json events that the orchestrator can parse.
# Usage: fake-agent.sh [claude args...] <prompt>

# Extract the prompt (last argument)
PROMPT="${@: -1}"

# Emit stream-json events
cat <<'JSONL'
{"type":"system","subtype":"init","session_id":"test-session-001","model":"fake-model","tools":[],"mcp_servers":[]}
{"type":"assistant","message":{"id":"msg_test","type":"message","role":"assistant","content":[{"type":"text","text":"I received your prompt and I'm working on it."}],"model":"fake-model","stop_reason":"tool_use"}}
{"type":"assistant","message":{"id":"msg_test2","type":"message","role":"assistant","content":[{"type":"text","text":"Task complete. Here is the result."}],"model":"fake-model","stop_reason":"end_turn"}}
{"type":"result","result":"Task complete. Here is the result.","total_cost_usd":0.0042,"is_error":false,"session_id":"test-session-001"}
JSONL

# Optionally create a file in the workspace to prove we ran
if [ -d /workspace/project ]; then
  echo "fake-agent was here" > /workspace/project/agent-output.txt
fi

exit 0
```

Make it executable: `chmod +x test/fake-agent.sh`

## Integration Test

`test/smoke.test.ts` — uses Node's built-in test runner.

```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

// Import db functions directly (orchestrator and test share the same process)
import { initDb, createJob, getJob, resetStaleJobs } from '../src/db.js';

// Override DB_PATH before importing config
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `macro-claw-test-${Date.now()}.db`,
);

// Create a temp project directory with a git repo
const tmpProjectDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'macro-claw-test-project-'),
);

before(() => {
  // Initialize git repo in temp project
  execSync('git init', { cwd: tmpProjectDir, stdio: 'pipe' });
  execSync('git config user.name "test"', {
    cwd: tmpProjectDir,
    stdio: 'pipe',
  });
  execSync('git config user.email "test@test.com"', {
    cwd: tmpProjectDir,
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(tmpProjectDir, 'README.md'), '# Test Project\n');
  execSync('git add -A && git commit -m "init"', {
    cwd: tmpProjectDir,
    stdio: 'pipe',
  });

  // Initialize test database
  initDb();
});

after(() => {
  // Clean up
  try {
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  } catch {}
  try {
    fs.unlinkSync(process.env.DB_PATH!);
  } catch {}
});

test('create and retrieve a job', () => {
  const jobId = createJob({
    prompt: 'Say hello',
    project_dir: tmpProjectDir,
    priority: 0,
  });

  const job = getJob(jobId);
  assert.ok(job, 'Job should exist');
  assert.strictEqual(job!.status, 'pending');
  assert.strictEqual(job!.prompt, 'Say hello');
  assert.strictEqual(job!.project_dir, tmpProjectDir);
});

test('resetStaleJobs moves running back to pending', () => {
  const jobId = createJob({
    prompt: 'Test stale job',
    project_dir: tmpProjectDir,
  });

  // Simulate: manually set to running (as if orchestrator crashed mid-dispatch)
  // Note: in real code, claimNextJob() does this atomically
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(process.env.DB_PATH!);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  db.close();

  const count = resetStaleJobs();
  assert.ok(count >= 1, 'Should reset at least 1 stale job');

  const job = getJob(jobId);
  assert.strictEqual(job!.status, 'pending');
});
```

## Testing with the Fake Agent (No Docker)

For testing without Docker, use `isolation: local` mode (or set a `CLAUDE_BINARY` env var override). The worker module should support a `claude_binary` override that lets you substitute the fake agent:

In `worker.ts`, add support for:

```typescript
const claudeBin = process.env.CLAUDE_BINARY || 'claude';
```

Then for local (non-Docker) testing:

```bash
CLAUDE_BINARY=./test/fake-agent.sh DB_PATH=./test.db npm run dev
```

## Testing with Docker (Full E2E)

1. Build the worker image with the fake agent baked in:

```dockerfile
# test/Dockerfile.fake-worker
FROM node:22-slim
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN git config --global user.name "test" && git config --global user.email "test@test.com"
COPY fake-agent.sh /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude
RUN printf '#!/bin/sh\nexec claude "$@"\n' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh
RUN mkdir -p /workspace/project /home/node/.claude && chown -R node:node /workspace /home/node
USER node
WORKDIR /workspace/project
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

2. Build and run:

```bash
docker build -t macro-claw-worker-test:latest -f test/Dockerfile.fake-worker test/
CONTAINER_IMAGE=macro-claw-worker-test:latest npm run dev
```

3. Submit a test job and verify the result comes back with the fake agent's output.

## What to Validate

1. **Job lifecycle**: pending → running → done
2. **Transcript capture**: full JSONL stream is stored in the `transcript` column
3. **Result text extraction**: `result_text` contains "Task complete. Here is the result."
4. **Cost tracking**: `cost_usd` is `0.0042` (from the fake agent)
5. **Worktree creation**: a worktree exists at the path stored in `worktree_path`
6. **Worktree cleanup on failure**: if the fake agent exits non-zero, the worktree is removed
7. **Crash recovery**: `resetStaleJobs()` moves `running` back to `pending` on startup
8. **Credential proxy**: starts on port 3001 (test that it responds to health checks)
