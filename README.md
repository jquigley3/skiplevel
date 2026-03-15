# macro-claw

A parallel task runner for Claude Code. Submit work, get results. While you're doing other things.

## What it does

macro-claw runs Claude Code sessions as queued jobs in isolated Docker containers. You describe a task, point it at a directory, and the orchestrator handles the rest — spawning a worker, running the session, capturing the full transcript and result, and storing everything for review.

Run one job or fifty in parallel. Tasks can spawn sub-tasks. Each worker gets its own git branch. Nothing shares state.

```
You submit a job
     ↓
Orchestrator picks it up from the queue
     ↓
Worker container runs  claude --print  on your prompt
     ↓
Result, transcript, and cost stored — ready to query
```

## Why macro-claw

**Claude Code is the right unit.** A Claude Code session can read code, run commands, write files, and reason about what it's doing. That's the right primitive for delegating real work — not a raw API call, not a chat message.

**Parallel, not sequential.** Most orchestration tools run one agent at a time and wait. macro-claw queues jobs and dispatches up to N workers concurrently. Submit a batch of tasks before bed; check results in the morning.

**Tasks that spawn tasks.** Workers can create child tasks via the tool API. A planning agent can break down a problem and fan out to specialists. Each child runs in its own container. The permission model ensures children can only access what their parent was allowed to access.

**No retries by default.** A failed job stays failed. This is intentional — retrying a broken prompt just burns tokens. Fix the prompt, resubmit explicitly.

**Your credentials stay on the host.** Workers never see your API key. The credential proxy injects real credentials per-request; workers hold a placeholder. The `.env` file is never mounted into containers.

## Quick Start

### Prerequisites

- macOS or Linux
- Docker Desktop (or Docker Engine on Linux)
- A Claude Code subscription or Anthropic API key

### Setup

```bash
git clone <this repo>
cd mc2
cp .env.example .env
# Add your credentials to .env (see below)

./dev.sh build   # Build orchestrator and worker images
./dev.sh up      # Start the orchestrator (run from a native terminal, not inside an IDE)
```

### Credentials

You need one of:

```bash
# Option A: API key (good for CI / unattended use)
ANTHROPIC_API_KEY=sk-ant-api03-...

# Option B: OAuth token from your Claude Code subscription (no per-token billing)
# Extract from macOS Keychain automatically:
./dev.sh token   # prints the token; paste it into .env as CLAUDE_CODE_OAUTH_TOKEN
```

### Submit your first job

```bash
./submit.sh /path/to/your/project "Review the code in src/ and write a summary of what it does"
```

You'll get a job ID. Check on it:

```bash
./result.sh <job-id>     # show status and result
./list.sh                # show all jobs
./dev.sh logs            # stream orchestrator logs
```

### Stop

```bash
./dev.sh down
```

## Core Concepts

### Jobs

A job is a prompt + a project directory. The orchestrator picks it up, creates an isolated git branch of your project, and runs `claude --print` with your prompt inside a container. When the session ends, the result text, full transcript, token cost, and duration are stored.

Jobs have a lifecycle: `pending → running → done | failed`. A failed job never retries automatically.

### Workers

Each job runs in its own Docker container. Workers share the Docker network with the orchestrator but have no other shared state. Each worker gets:

- A copy of your project on a fresh git branch (worktree)
- Injected job credentials (token, job ID, API URL)
- Access only to directories you've explicitly permitted

### Tools

Workers can be granted **tools** — permissions to use the orchestrator's capability API. Currently:

| Tool | What it does |
|---|---|
| `spawn_task` | Create child tasks from within a running job |

Grant a tool when submitting:

```bash
./submit.sh /path/to/project "Your prompt" --tools spawn_task
```

### Allowed Paths

By default, workers can read and write within their project worktree. You can expand or restrict this with `--allowed-paths`:

```bash
./submit.sh /my/project "Your prompt" \
  --tools spawn_task \
  --allowed-paths /my/project,/tmp/shared-data
```

Child tasks inherit their parent's `allowed_paths`. They cannot exceed it.

### Token Management

macro-claw respects API rate limits and quota. Jobs queue up while workers are busy or tokens are unavailable, and are dispatched as capacity returns. Set `MAX_CONCURRENT_WORKERS` to control parallelism.

```bash
# .env
MAX_CONCURRENT_WORKERS=5   # run up to 5 jobs at once
```

## Submitting Jobs

### CLI

```bash
./submit.sh <project-dir> "<prompt>" [flags]

Flags:
  --model <name>                     Model override (e.g. claude-opus-4-5)
  --priority <n>                     Lower numbers run first (default: 0)
  --tools <tool1,tool2>              Grant mc2 tools to this job
  --allowed-paths <path1,path2>      Restrict filesystem access
  --append-system-prompt <text>      Append to Claude's system prompt
  --append-system-prompt-file <file> Read and append a file to the system prompt
```

### HTTP API

The orchestrator exposes a local HTTP API on port 3001:

```bash
# Submit
curl -s -X POST http://localhost:3001/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Refactor the auth module to use async/await",
    "project_dir": "/my/project",
    "tools": ["spawn_task"],
    "max_budget_usd": 2.00
  }'

# Check status
curl -s http://localhost:3001/api/jobs/<job-id>

# List all jobs
curl -s 'http://localhost:3001/api/jobs?status=running'
```

This API is how workers submit child tasks too — they just use a different endpoint (`/api/tasks`) with their job token for auth.

## Multi-Agent Tasks

Tasks can spawn sub-tasks. This enables patterns like:

- A planner that breaks down a problem, fans out to N specialists, waits for results, and synthesises
- A test runner that spawns separate jobs for unit tests, integration tests, and linting, then reports
- A code review agent that spawns one worker per changed file

Grant the `spawn_task` tool and include the tool reference (from `developer/tools.md`) in the system prompt:

```bash
./submit.sh /my/project \
  "Analyse this codebase. Spawn one sub-task per module to write documentation, then compile it all into a single README." \
  --tools spawn_task \
  --allowed-paths /my/project \
  --append-system-prompt-file developer/tools.md
```

Workers receive `MC2_API_URL`, `MC2_JOB_TOKEN`, and `MC2_JOB_ID` as environment variables. The `developer/tools.md` file in this repo contains the full API reference for workers.

## Configuration

All config is via environment variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | API key (option A) |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | OAuth token (option B) |
| `MAX_CONCURRENT_WORKERS` | `1` | Max parallel jobs |
| `CONTAINER_TIMEOUT` | `1800000` | Worker timeout in ms (30 min) |
| `JOB_POLL_INTERVAL` | `5000` | Queue poll interval in ms |
| `CONTAINER_IMAGE` | `macro-claw-worker:latest` | Worker Docker image |
| `LOG_LEVEL` | `info` | Log verbosity |

## Roadmap

These are planned but not yet implemented:

**Token-aware scheduling** — the queue already holds jobs when workers are at capacity. We plan to extend this to handle API rate limits gracefully, so jobs retry automatically when tokens are available rather than failing.

**Project-level sessions** — Claude Code has native session continuity. We plan to support resuming a session at the project level, so a series of related jobs can share context without re-reading the codebase from scratch each time.

**Task scheduler** — submit jobs on a cron or interval schedule. Useful for recurring reviews, reports, and maintenance tasks.

**Multiple execution harnesses** — today workers run `claude`. The architecture is designed to support alternatives: Codex, Open WebUI, Ollama, or any API-compatible endpoint. Swap the worker image and execution command; the queue, tool system, and credential proxy stay the same.

**nanoclaw integration** — macro-claw shares DNA with [nanoclaw](https://github.com/qwibitai/nanoclaw) (same credential proxy, same Docker isolation pattern). A Claude Code session feels like a more natural unit of execution than the Agent SDK session model nanoclaw uses today. We plan to contribute macro-claw's job queue and tool system back upstream, or align closely as both projects evolve.

## Development

```bash
./dev.sh typecheck   # type-check TypeScript
./dev.sh test        # run smoke tests in a container
./dev.sh rebuild     # clean rebuild of all images
./dev.sh logs        # tail orchestrator logs
```

See `developer/notes.md` for architecture notes and `developer/tools.md` for the worker tool API reference.

## Troubleshooting

**Orchestrator won't start / containers exit with code 137**

Run `./dev.sh up` from a native terminal (Terminal.app, iTerm2), not from inside an IDE's integrated terminal. Some IDEs (including Cursor) wrap terminals in a sandbox that kills containers that bind host ports.

**Job stuck in `running` after a restart**

On startup, the orchestrator fails any job that was `running` at crash time. It will never be automatically retried. Check `./result.sh <id>` for the error, then resubmit if needed.

**Worker can't reach the proxy**

Verify both containers are on `macro-claw-net`:
```bash
docker network inspect macro-claw-net
```

**OAuth token expired**

```bash
./dev.sh token   # re-extract from macOS Keychain and update .env
# No restart needed — the proxy re-reads .env on every request
```

## Security

Workers never see real credentials. The credential proxy injects them per-request from the host `.env`, which is never mounted into any container. Each worker gets a unique job token that expires when the job ends. Child tasks can only access paths explicitly permitted by their parent.

See `developer/notes.md` for the full security model.

## License

MIT
