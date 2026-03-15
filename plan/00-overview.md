# macro-claw: Build Plan Overview

## What You Are Building

**macro-claw** is a task orchestrator that dispatches work to isolated Claude Code CLI instances. It is built on top of [nano-claw](https://github.com/jmandel/nanoclaw) (a lightweight agent container system), stripped down and repurposed.

The key idea: a deterministic, auditable Node.js daemon picks up tasks from a SQLite queue, spawns a Claude Code CLI process in a Docker container for each task, captures the full session transcript (reasoning + tool calls + final response), and returns it to the caller. No LLM in the orchestrator itself.

## Architecture at a Glance

```
                    ┌──────────────────────────────────────┐
                    │          SQLite Task Queue            │
                    │  (jobs table: pending → running →     │
                    │   done/failed)                        │
                    └──────────┬───────────────────────────┘
                               │ poll every 5s
                    ┌──────────▼───────────────────────────┐
                    │        Orchestrator (Node.js)         │
                    │  - Pure code, no LLM                  │
                    │  - Runs inside Docker                 │
                    │  - Spawns sibling containers          │
                    │  - Captures stream-json transcript    │
                    │  - Credential proxy (HTTP, port 3001) │
                    └──────────┬───────────────────────────┘
                               │ docker run ...
                    ┌──────────▼───────────────────────────┐
                    │      Worker Container (per job)       │
                    │  - node:22-slim + claude CLI          │
                    │  - Git worktree (isolated copy)       │
                    │  - --output-format stream-json        │
                    │  - --dangerously-skip-permissions     │
                    │  - Talks to credential proxy, NOT     │
                    │    directly to api.anthropic.com      │
                    └──────────────────────────────────────┘
```

## What nano-claw Gives You

nano-claw already has:

- **Container spawning** (`container-runner.ts`) — Docker run with bind mounts, credential injection, stream-json parsing
- **Credential proxy** (`credential-proxy.ts`) — HTTP proxy that injects API keys or OAuth tokens so containers never see real secrets
- **Container runtime abstraction** (`container-runtime.ts`) — Docker binary detection, host gateway resolution, orphan cleanup
- **Mount security** (`mount-security.ts`) — allowlist-based validation of bind mounts
- **IPC via filesystem** (`ipc.ts`) — JSON file exchange between host and container
- **Docker image** (`container/Dockerfile`) — node:22-slim with Claude Code CLI installed
- **Logging** (`logger.ts`) — pino with pino-pretty

## What You Will Change / Add

| nano-claw has                             | macro-claw needs                                  | Action                                              |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| Message-driven (WhatsApp/Telegram/etc)    | Task queue driven                                 | **Replace**: rip out channels, add SQLite job queue |
| Per-group workspaces                      | Per-job git worktrees                             | **Replace**: worktree-per-job isolation             |
| `index.ts` main loop (message routing)    | `orchestrator.ts` (poll queue, dispatch, collect) | **Rewrite**                                         |
| `db.ts` (messages, sessions)              | `db.ts` (jobs table only)                         | **Rewrite**                                         |
| `group-queue.ts` (per-group concurrency)  | Simple max-concurrent limiter                     | **Simplify**                                        |
| `ipc.ts` (bidirectional message exchange) | Job result capture (transcript return)            | **Simplify**                                        |
| `container-runner.ts`                     | Keep most of it, adapt mounts                     | **Adapt**                                           |
| `credential-proxy.ts`                     | Keep as-is                                        | **Keep**                                            |
| `container-runtime.ts`                    | Keep as-is                                        | **Keep**                                            |
| `mount-security.ts`                       | Keep as-is                                        | **Keep**                                            |
| `container/Dockerfile`                    | Keep as-is                                        | **Keep**                                            |
| Channels (WhatsApp, Telegram, etc)        | Not needed                                        | **Delete**                                          |
| Agent runner / agent SDK                  | Not needed (we use `claude --print`)              | **Delete**                                          |
| Task scheduler (cron)                     | Not needed                                        | **Delete**                                          |
| Router (message delivery)                 | Not needed                                        | **Delete**                                          |

## Document Index

1. **[01-setup.md](./01-setup.md)** — Fork nano-claw, strip it down, get a clean starting point
2. **[02-database.md](./02-database.md)** — SQLite schema for the job queue
3. **[03-orchestrator.md](./03-orchestrator.md)** — The main loop: poll, dispatch, collect
4. **[04-worker.md](./04-worker.md)** — How a worker container is spawned and what it returns
5. **[05-credentials.md](./05-credentials.md)** — API key and OAuth token setup (including Keychain extraction)
6. **[06-docker.md](./06-docker.md)** — Docker Compose, networking, image builds
7. **[07-api.md](./07-api.md)** — How callers submit jobs and retrieve results
8. **[08-testing.md](./08-testing.md)** — Integration tests with a fake agent
