# Developer Notes

## Architecture

mc2 (macro-claw) is a task orchestrator that dispatches Claude Code CLI invocations to isolated Docker containers. Key components:

- **Orchestrator** (`orchestrator/src/orchestrator.ts`) — polls the SQLite job queue for pending jobs, claims them atomically, creates git worktrees (if applicable), and spawns worker containers.
- **Credential Proxy** (`orchestrator/src/credential-proxy.ts`) — HTTP proxy on port 3001. Intercepts Anthropic API calls from workers and injects real credentials (API key or OAuth token). Also routes `/api/tasks` and `/api/jobs` requests to the capability API.
- **Tool API** (`orchestrator/src/tools.ts`) — REST endpoints for task spawning (worker-facing, Bearer token auth) and job management (host-facing, no auth).
- **Worker** (`orchestrator/src/worker.ts`) — builds Docker `run` arguments and spawns `claude` CLI in a container. Parses `stream-json` output for transcripts, costs, and results.
- **Job Queue** (`orchestrator/src/db.ts`) — SQLite via `better-sqlite3`. WAL mode. Single-writer (orchestrator process only) to avoid VirtioFS locking issues on macOS Docker.

## Known Issues

### Worker polling for child task completion

When a parent task spawns children and polls their status in a bash loop (e.g., `for i in $(seq 1 30); do curl ...; sleep 10; done`), the task can get stuck or run until max turns. The polling loop often doesn't break cleanly when children finish. Possible improvements:

- **Webhook/callback**: Have the orchestrator notify the parent when children complete, instead of requiring polling.
- **Blocking endpoint**: Add `GET /api/tasks/:id?wait=true` that long-polls until the task finishes.
- **Dedicated tool**: Instead of curl-in-bash, provide an MCP tool or structured mechanism for "wait for tasks".

### SQLite over Docker VirtioFS (macOS)

SQLite WAL mode has known issues with Docker's VirtioFS on macOS. The current solution is that **only the orchestrator process accesses the database** — all external access goes through the HTTP API (port 3001). Do not access the `.db` file directly from the host while the orchestrator is running.

### Cursor sandbox interference

Cursor's `cursorsandbox` terminal wrapper can kill containers that bind host ports. Run `./dev.sh up` from a native terminal (Terminal.app, iTerm2) rather than Cursor's integrated terminal if containers are being killed with exit code 137.

## Tool System

### Current tools

| Tool | Description |
|---|---|
| `spawn_task` | Create child tasks via `POST /api/tasks` |

### Adding a new tool

1. Choose a tool name (e.g., `read_file`, `web_search`).
2. Add the handler in `tools.ts` — check `hasTool(caller, 'your_tool')`.
3. Document the endpoint in `developer/tools.md` so workers know how to use it.
4. If it needs new DB fields, add them to the `Job` interface, `CreateJobInput`, `initDb()` migration block, and `createJob()`.

### Allowed paths

The `allowed_paths` capability restricts which host directories a task can access. Child tasks inherit their parent's `allowed_paths` by default. A child's `allowed_paths` must be a subset of the parent's. The `project_dir` for child tasks must also fall within the parent's `allowed_paths`.

## Future Development Ideas

### Tool ideas
- **`read_results`** — let a task read the full result/transcript of a sibling or ancestor task.
- **`cancel_task`** — let a parent cancel a running child task.
- **`web_search`** / **`web_fetch`** — proxy web access through the orchestrator for sandboxed workers.
- **`artifact_store`** — upload/download build artifacts between tasks without shared filesystem access.

### Architectural improvements
- **Remove `project_dir` as a required field** — it doesn't fit the permission model well. Tasks should declare their `allowed_paths` and the orchestrator should derive the working directory.
- **Task dependencies / DAG** — instead of polling, let tasks declare dependencies (e.g., "run after task X completes") and have the orchestrator schedule them.
- **Result streaming** — expose a streaming endpoint so parent tasks (or humans) can watch child task progress in real time.
- **Cost budgets** — enforce per-task and per-tree cost limits. Currently `max_budget_usd` is passed to the CLI but not enforced at the orchestrator level.
- **Retry policy** — currently no retries (by design). If needed, add opt-in retry with configurable max attempts per job.
- **Task metadata / tags** — allow arbitrary key-value metadata on jobs for filtering and organization.

### Operational improvements
- **Web dashboard** — simple UI to view job status, logs, and costs.
- **Metrics / observability** — export job counts, durations, costs to Prometheus or similar.
- **Graceful shutdown** — on SIGTERM, stop claiming new jobs and wait for running workers to finish before exiting.
- **Database cleanup** — periodic purge of old completed/failed jobs and their transcripts.

## Passing Tool Instructions to Workers

Workers receive tool instructions through two mechanisms, both already supported:

1. **`append_system_prompt`** (job field) — passed as `--append-system-prompt` to the Claude CLI. Content is appended to the default system prompt. Set this when creating jobs via the API.

2. **`claude_md`** (job field) — written as `CLAUDE.md` in the worker's project directory. Claude Code auto-reads this file on startup. Good for project-specific instructions.

See `developer/tools.md` for the capability API reference that should be included in worker prompts.
