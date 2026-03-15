# Agent Harness — Tasks

## Phase 0: Container Sandbox Setup

- [x] Build Docker container image with Claude Code CLI
- [x] Test sandboxed Claude CLI can run and access PKB (read-only)
- [x] Test sandboxed Claude CLI can write to its project directory only
- [x] Auth: extract OAuth from macOS keychain, pass as env var
- [x] File-based IPC: task.md → status.md/result.md protocol tested end-to-end
- [ ] Document how to launch a sandboxed session

## Phase 1: Project & State Model

- [x] Design project state schema (directory layout, metadata files) — HARNESS-001
- [x] Design task/deliverable state machine (backlog → assigned → in-progress → review → done) — HARNESS-001
- [x] Design resource model (machines, accounts, token windows) — HARNESS-002
- [ ] Implement CLI or scripts for project CRUD
- [ ] Reconcile tasks.md with tasks/\*.yaml — decide single source of truth

## Meta: Developer Experience

- [x] Write AGENT.md for _developers_ of this project: how to make a change, rebuild the proxy/orchestrator, and re-run a smoke test end-to-end
- [x] dev.sh — single script for rebuild (no-cache), restart, logs, status, dispatch, token refresh
- [x] Random branch suffix for worktrees — `agent/<taskId>-<suffix>` matches container name, eliminates branch collisions on retries
- [x] Enriched ipc/task.md — includes priority, deliverables, explicit "no docker commands" note
- [x] Fix stale OAuth — `.env` mounted as volume; orchestrator re-reads token fresh at each dispatch; `./dev.sh dispatch` now refreshes from Keychain before queuing

## Meta: Process Improvements

- [ ] Develop skills.md for clarifying tasks with the user — iterate until both agent and user are confident the task can be delegated to a sub-agent without further input

## Phase 1.5: Observability

- [x] Sub-agents commit work to git with reasoning in commit messages (audit trail)
- [x] Orchestrator commits at dispatch/completion for startup/teardown logging
- [ ] Initialize git at project creation time (worktree isolation requires it — see notes/worktree-isolation.md)
- [ ] Add `git log --oneline` summary to orchestrator's post-task logging
- [ ] Build/typecheck orchestrator inside its Docker container, not on host

## Phase 1.6: Session Management

- [ ] Add `sessions` section to resources.yaml (id, name, project, directory, state, active_tasks)
- [ ] Track top session and project sessions as resources
- [ ] Implement session state machine: interactive → autonomous → blocked → idle
- [ ] `/go` slash command: create task YAMLs from scoped work, flip session to autonomous
- [ ] Natural language trigger: detect delegation intent, confirm via AskUserQuestion before dispatching
- [ ] Detect blocked state: all active_tasks in `review` or failed → mark session blocked
- [ ] Session picker integration: show session states alongside names in `--resume`
- [ ] Fork-to-project-session: fork current conversation when scoping narrows to one project
- [ ] Notification on autonomous → blocked transition (terminal bell, NanoClaw/WhatsApp)

## Phase 2: Planning & Delegation

- [ ] Design planning workflow (user ↔ agent ↔ sub-agent)
- [ ] Implement sub-agent spawning with container
- [ ] Implement task assignment and progress tracking
- [ ] Implement sub-agent output collection and state updates
- [ ] Automate the task dispatch loop (so host agent doesn't require manual `docker run` commands)

## Phase 1.5: Observability (continued)

- [x] Sub-agents need isolated git worktrees (not shared project dir) — HARNESS-009

## Phase 3: Scheduling & Resource Management

- [ ] Implement token budget tracking
- [ ] Monitor rate limits (RPM/RPD) in addition to token windows — see notes/2026-03-14-rate-limits.md
- [ ] Rate limiting & recovery strategy — HARNESS-010 (needs clarification)
- [ ] Implement priority-based scheduling across projects
- [ ] Implement resource allocation (which machine/account runs what)

## Phase 4: Dogfooding

- [x] Migrate an existing PKB project into the harness — complaint-automator added
- [ ] Run a full cycle: plan → delegate → execute → review

## Phase 1.5: Observability (continued — post stream-json refactor)

- [ ] `IDLE_TIMEOUT` grace period in container-runner.ts is a nanoclaw-ism (for keeping a session alive after user goes idle). Task-based sessions run to completion — evaluate whether this timeout logic is needed at all or should be replaced with a simpler per-task deadline.

## Known Issues

- [ ] `resolveSessionConfig()` in session-builder.ts has side effects (writes mcp_config temp file, creates .claude/ session dir) — should be pure input→output; side effects should move to dispatch layer
- [ ] Claude CLI inside container warns about installMethod=native and missing `/home/node/.local/bin/claude` — the host's `.claude.json` says `installMethod: native` but the container installed via npm. Entrypoint writes `{"installMethod":"npm"}` but may not fully suppress warnings
- [ ] Claude CLI reports "switched from npm to native installer" — may need native installer in Dockerfile instead of `npm install -g`
- [ ] complaint-automator CA-001 scaffolded into `app/` subdirectory but CLAUDE.md expects files at project root (`lib/db/schema.ts` not `app/lib/db/schema.ts`) — reconcile directory structure
- [ ] Task YAML `deliverables` paths use container paths (`/workspace/project/...`) instead of relative paths — should be relative for portability
- [ ] resources.yaml currently lives inside agent-harness project but should be at harness root level (global resource, shared across projects)
- [ ] Sub-agent concurrent access: MVP shares `~/.claude/` mount — for parallel agents, snapshot at launch time instead of sharing

## Phase 5: Persistent Orchestrator

- [ ] Evaluate: build on NanoClaw rather than building a separate orchestrator — it already has container runner, credential proxy, task scheduler, launchd service, multi-channel input
- [ ] Run orchestrator itself in Docker (with docker.sock for sibling container spawning) — sandboxes Node.js away from host dev tools
- [ ] Evaluate docker-socket-proxy to restrict orchestrator's Docker API access (allow create/start/stop/inspect only)
- [ ] Design "CLI channel" for NanoClaw — primary input for planning/review (alongside WhatsApp for on-the-go status)
- [ ] Extend NanoClaw's task scheduler to manage harness task queue (tasks/\*.yaml)
- [ ] Add project/task management as a NanoClaw capability (group = project, tasks = scheduled jobs)
- [ ] Orchestrator spawns/monitors Docker sub-agents, collects results, updates task state
- [ ] Orchestrator survives user closing their terminal / shutting laptop lid
- [ ] User reconnects via CLI or WhatsApp to review progress, approve plans, adjust priorities

## Future

- [ ] Upgrade macOS to 26+ and switch from Docker to Apple Container (lightweight Linux VMs)
- [ ] Test and improve the new-user experience when Docker isn't running (clear error message, auto-start prompt, setup instructions)
- [ ] Improve auth bootstrapping: on first interactive run, ask user whether to reuse existing Claude Code OAuth or provide an API key. For sub-agent launches, auth must be fully automatic with no user interaction
- [ ] Consider deeper NanoClaw integration — share container image or runtime abstraction, but keep harness standalone
- [ ] Credential proxy (NanoClaw-style) instead of keychain extraction — more secure, handles token refresh
