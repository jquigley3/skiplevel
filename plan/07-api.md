# 07 — Submitting Jobs and Retrieving Results

## How Callers Interact with the Queue

The orchestrator is a daemon that polls SQLite. Callers interact by writing to and reading from the same SQLite database. There are three approaches, from simplest to most flexible:

## Approach 1: CLI Script (Recommended Starting Point)

A simple `submit.sh` and `result.sh` that use `sqlite3` directly.

### submit.sh — Submit a Job

```bash
#!/usr/bin/env bash
# Usage: ./submit.sh <project-dir> <prompt> [--model claude-sonnet-4-5] [--priority 0]
set -euo pipefail

DB="./data/macro-claw.db"
PROJECT_DIR="${1:?Usage: ./submit.sh <project-dir> <prompt>}"
PROMPT="${2:?Usage: ./submit.sh <project-dir> <prompt>}"
MODEL="${3:-}"
PRIORITY="${4:-0}"

JOB_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

sqlite3 "$DB" "INSERT INTO jobs (id, prompt, project_dir, model, priority)
  VALUES ('$JOB_ID', '$(echo "$PROMPT" | sed "s/'/''/g")', '$PROJECT_DIR', $([ -n "$MODEL" ] && echo "'$MODEL'" || echo "NULL"), $PRIORITY);"

echo "Job submitted: $JOB_ID"
echo "Check status:  ./result.sh $JOB_ID"
```

### result.sh — Check Job Status and Get Result

```bash
#!/usr/bin/env bash
# Usage: ./result.sh <job-id> [--transcript]
set -euo pipefail

DB="./data/macro-claw.db"
JOB_ID="${1:?Usage: ./result.sh <job-id>}"
SHOW_TRANSCRIPT="${2:-}"

if [ "$SHOW_TRANSCRIPT" = "--transcript" ]; then
  sqlite3 -json "$DB" "SELECT id, status, result_text, transcript, cost_usd, duration_ms, error, worktree_path FROM jobs WHERE id = '$JOB_ID';"
else
  sqlite3 -json "$DB" "SELECT id, status, result_text, cost_usd, duration_ms, error, worktree_path FROM jobs WHERE id = '$JOB_ID';"
fi
```

### list.sh — List Jobs

```bash
#!/usr/bin/env bash
DB="./data/macro-claw.db"
STATUS="${1:-}"

if [ -n "$STATUS" ]; then
  sqlite3 -column -header "$DB" "SELECT id, status, substr(prompt,1,60) as prompt, priority, cost_usd, duration_ms FROM jobs WHERE status = '$STATUS' ORDER BY created_at DESC LIMIT 20;"
else
  sqlite3 -column -header "$DB" "SELECT id, status, substr(prompt,1,60) as prompt, priority, cost_usd, duration_ms FROM jobs ORDER BY created_at DESC LIMIT 20;"
fi
```

## Approach 2: Node.js Client Library

For programmatic access from TypeScript/JavaScript:

```typescript
// client.ts — import and use directly
import { initDb, createJob, getJob, listJobs } from './db.js';

initDb();

// Submit a job
const jobId = createJob({
  prompt:
    'Read the codebase and write a comprehensive test suite for src/auth.ts',
  project_dir: '/Users/josh/Developer/my-project',
  model: 'claude-sonnet-4-5',
  max_turns: 30,
  max_budget_usd: 1.0,
  claude_md: `# Instructions\nFocus only on testing. Do not modify source code.`,
  priority: 0,
});
console.log(`Submitted: ${jobId}`);

// Poll for result
const poll = setInterval(() => {
  const job = getJob(jobId);
  if (!job) return;
  if (job.status === 'done' || job.status === 'failed') {
    clearInterval(poll);
    console.log(`Status: ${job.status}`);
    console.log(`Result: ${job.result_text}`);
    console.log(`Cost: $${job.cost_usd}`);
    if (job.worktree_path) {
      console.log(`Workspace: ${job.worktree_path}`);
    }
  }
}, 2000);
```

## Approach 3: HTTP API (Future Enhancement)

Not in the initial build, but easy to add later. A thin Express server wrapping the db functions:

```
POST /jobs          — create a job
GET  /jobs/:id      — get job status + result
GET  /jobs          — list jobs (with ?status= filter)
```

## Job Lifecycle From the Caller's Perspective

```
1. Caller creates a job (status: pending)
   └─ via submit.sh, client.ts, or direct SQL INSERT

2. Orchestrator picks it up (status: running)
   └─ claimNextJob() atomically moves pending → running

3. Worker container executes
   └─ Claude Code CLI runs with the prompt
   └─ Stream-json output captured as transcript

4. Job completes (status: done or failed)
   └─ result_text: Claude's final response
   └─ transcript: full JSONL session log
   └─ cost_usd: total API cost
   └─ worktree_path: where the agent's file changes live
   └─ error: (if failed) what went wrong

5. Caller reads the result
   └─ via result.sh, getJob(), or direct SQL SELECT
```

## What the Caller Gets Back

| Field             | When        | Description                                                                                   |
| ----------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `result_text`     | done        | Claude's final response text. This is the "answer".                                           |
| `transcript`      | done/failed | Full JSONL stream. Parse to see reasoning, tool calls, intermediate steps.                    |
| `cost_usd`        | done        | How much this job cost in API credits.                                                        |
| `worktree_path`   | done        | Absolute path to the git worktree. `cd` there to see file changes, `git diff main` to review. |
| `worktree_branch` | done        | Git branch name (`worker/<jobId>-<suffix>`). Merge it if you want the changes.                |
| `error`           | failed      | Error message explaining what went wrong.                                                     |
| `duration_ms`     | done/failed | Wall clock time from dispatch to completion.                                                  |

## Example: Submit and Wait

```bash
# Submit
JOB_ID=$(./submit.sh /Users/josh/Developer/my-app "Fix the bug in src/parser.ts where it crashes on empty input" | grep -oP '[a-f0-9-]{36}')

# Wait for completion
while true; do
  STATUS=$(sqlite3 ./data/macro-claw.db "SELECT status FROM jobs WHERE id = '$JOB_ID'")
  case "$STATUS" in
    done)
      echo "Done!"
      ./result.sh "$JOB_ID"
      break
      ;;
    failed)
      echo "Failed!"
      ./result.sh "$JOB_ID"
      break
      ;;
    *)
      echo "Status: $STATUS ..."
      sleep 5
      ;;
  esac
done
```
