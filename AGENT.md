# AGENT.md — Developer Inner Loop Guide

A guide for making changes, testing them, and confirming results — no prior
knowledge of this project required.

---

## Stack Overview

Three services run via docker-compose: **orchestrator** (Node.js) polls
`tasks/*.yaml` for `status: assigned` and spawns **agent-claude** sub-agent
containers via the Docker socket; **proxy** (mitmproxy) intercepts all Claude
API traffic for rate-limiting and token tracking. Sub-agents run isolated in
their own containers, writing progress to `ipc/status.md` and results to
`ipc/result.md` inside a per-task git worktree.

---

## Developer Inner Loop

```
make change → ./dev.sh rebuild → ./dev.sh dispatch <ID> → ./dev.sh logs → iterate
```

**Rule: if you edited any file, run `./dev.sh rebuild` before dispatching.**
The running containers do not see file edits — only a rebuild picks them up.

### What requires a rebuild?

| Changed file | Required action |
|---|---|
| `orchestrator/src/**` | `./dev.sh rebuild` |
| `orchestrator/Dockerfile` | `./dev.sh rebuild` |
| `container/Dockerfile` | `./dev.sh rebuild` |
| `proxy/addon.py` | `./dev.sh rebuild` |
| `docker-compose.yaml` | `./dev.sh rebuild` |
| `orchestrator/.env` | nothing — re-read live at each dispatch |
| `tasks/*.yaml` | nothing — polled directly from disk |
| `AGENT.md`, `README.md`, etc. | nothing |

### 1. Make a change
Edit the relevant file: orchestrator source (`orchestrator/src/`), container
(`container/Dockerfile`), or proxy (`proxy/addon.py`).

### 2. Rebuild and restart

```bash
./dev.sh rebuild   # no-cache build of ALL images + restart
```

This must be run after every source/Dockerfile/compose edit. It stops the
running stack, rebuilds all images with `--no-cache`, and restarts. There is
no partial rebuild — always rebuild everything to avoid stale layer combinations.

### 3. Dispatch a smoke test

```bash
./dev.sh dispatch HARNESS-016   # queue an existing smoke test task
```

Or create a new one: copy a task YAML, give it a new ID, set `status: assigned`,
then dispatch. The orchestrator picks it up within 5 seconds.

### 4. Observe

```bash
./dev.sh logs   # tails docker logs -f agent-harness-orchestrator
```

Sub-agent lines are prefixed with `[TASK-ID]` and stream in real time.
Proxy stats (token usage, rate limits): `./dev.sh status` or http://localhost:8001.

### 5. Check the result

Sub-agent output is in the task's worktree, not the project root:
- Progress: `worktrees/<TASK-ID>/ipc/status.md`
- Result: `worktrees/<TASK-ID>/ipc/result.md`

Exact path is printed in orchestrator logs at task start. Task YAML status
progresses: `assigned → in-progress → review` (or back to `assigned` on failure).

### 6. Iterate

Update your hypothesis, repeat from step 1. Create a new smoke test ID each
attempt to avoid worktree collisions (SMOKE-001, SMOKE-002, …).

---

## Common Pitfalls

**Volume mount paths**: Docker runs on the host. The orchestrator passes
`HOST_PROJECTS_DIR` (host path) to Docker when mounting volumes for sibling
sub-agent containers — not the container-internal `PROJECTS_DIR`. If mounts
look wrong, check both env vars in `docker-compose.yaml`.

**Buffered output**: Sub-agent output is streamed in real time because the
orchestrator runs Claude with `--output-format stream-json`, which emits one
JSON event per line. Each tool call, assistant message, and result appears
in logs as it happens. The `[task.id] [tool:Foo]` and `[task.id] [text]`
log prefixes identify which sub-agent produced each line.

**Worktree isolation**: Each task gets its own git worktree under
`worktrees/<task-id>/`. IPC files (`ipc/status.md`, `ipc/result.md`) are
written there — reading the project root's `ipc/` will show the last task run
by this agent session, not a specific task's output.

**Stale container image**: Editing `container/Dockerfile` or `entrypoint.sh`
has no effect until you rebuild. Use `./dev.sh rebuild` — it forces `--no-cache`
across all images. Plain `docker compose build` may skip layers due to caching.

**Missing or expired credentials**: The orchestrator requires `ANTHROPIC_API_KEY`
or `CLAUDE_CODE_OAUTH_TOKEN` in `orchestrator/.env`. `./dev.sh dispatch` refreshes
the token from macOS Keychain automatically before queuing. If tasks fail with 401
errors and you're not using `dispatch`, run `./dev.sh token` manually to refresh.
