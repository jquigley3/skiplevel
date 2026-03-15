# DO_NEXT — handoff for next agent session

**Repo:** `/Users/josh/Developer/macro-claw`
**Date:** 2026-03-14

---

## What was done this session

### Goal

Build a testable new-user flow: install the harness, run a first task through
the orchestrator. Four tasks were dispatched (HARNESS-019 to 022).

### Bugs found and fixed (in orchestrator source)

1. **`isolation: worktree` breaks inside Docker** (`session-builder.ts`)
   `assertNativeHost` runs `which claude` — not on PATH inside the orchestrator
   container. Sub-agent task specs must use `isolation: docker` when the
   orchestrator runs in Docker. Fixed: all new task YAMLs updated.

2. **Mount denied on Docker Desktop** (`session-builder.ts` `ensureTaskSessionDir`)
   Session dirs were created at `/app/data/sessions/...` (inside a named volume),
   which Docker Desktop can't bind-mount into sibling containers. Fixed: session
   dirs now live inside the worktree (`config.workDir/.claude-session`), which is
   on a host bind-mount. Sibling containers can mount them correctly.

3. **`claude_binary` override added** (`session-spec.ts`, `session-builder.ts`)
   New optional field `AgentSpec.claude_binary` / `SessionConfig.claude_binary`.
   When set, replaces `claude` as the spawned binary (used by tests with
   `fake-agent.sh`). Also skips `assertNativeHost` check when set.

---

## Completed deliverables

| File                                  | Status                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `docker-compose.yaml`                 | Fixed — hard-coded user paths replaced with `${HOST_PROJECTS_DIR}` and `${HOST_PKB_DIR:-/dev/null}` |
| `.env.example`                        | Created — documents all env vars with Quick start block                                             |
| `orchestrator/.env.example`           | Already existed and was fine                                                                        |
| `projects/smoke/project.yaml`         | Created — minimal smoke project                                                                     |
| `projects/smoke/CLAUDE.md`            | Created                                                                                             |
| `projects/smoke/tasks/SMOKE-001.yaml` | Created — `status: assigned`, self-contained task                                                   |
| `scripts/fake-agent.sh`               | Created — reads `ipc/task.md`, writes `ipc/result.md`, exits 0; emits stream-json line              |
| `orchestrator/src/session-spec.ts`    | Updated — `claude_binary?: string` added to `AgentSpec` and `SessionConfig`                         |
| `orchestrator/src/session-builder.ts` | Updated — uses `claude_binary` when set; skips `assertNativeHost`; fixed `ensureTaskSessionDir`     |

---

## Outstanding work

### 1. `/setup` skill — HARNESS-020 (NOT in repo yet)

The sub-agent completed this task (pkb worktree `HARNESS-020-*`) but was
interrupted before review. The skill **does not yet exist** in this repo.

**What to build:** `.claude/skills/setup/SKILL.md`

Requirements:

- Use `!`command``dynamic injection to check live state: Docker running?,`orchestrator/.env` exists?, credentials set?, images built?, orchestrator running?
- Accept `--check-only` arg (`$ARGUMENTS`) — report state, take no action
- If not check-only: copy `.env.example` → `orchestrator/.env` if missing,
  run `npm install` in `orchestrator/`, run `docker compose build`, run
  `docker compose up -d`
- Output a clear readiness summary (✓/✗ per item)
- Reference `AGENT.md` for commands, `docker-compose.yaml` for service names
- Allowed tools: `Bash`, `Read`, `Write`, `Glob`

After writing the skill, test it using the **Claude.ai skill-creator**:

- Run description optimizer against sample prompts:
  "I just cloned the repo", "check my setup", "is the orchestrator running?",
  "setup is done, run a task" (should NOT trigger)
- Define eval cases for: fresh install, partial install, `--check-only`, Docker not running

### 2. Integration test — HARNESS-022 (broken, low priority)

`test/integration/first-task.test.ts` exists but fails. The orchestrator
subprocess spawned by the test uses `npx tsx` (the `.bin/tsx` wrapper is
broken on Node 24 — references a missing `.mjs` shim file).

**Root cause:** `tsx@4.19` binary wrapper incompatible with Node 24.14.0.
**Fix options:**
a. In the test, spawn the orchestrator with
`node node_modules/tsx/dist/cli.mjs src/orchestrator.ts` instead of
`npx tsx src/orchestrator.ts`
b. Upgrade tsx: `npm install tsx@latest` in `orchestrator/`

The test logic itself is correct. Once the spawn command is fixed it should pass.

---

## Key file locations

| What                                       | Where                                                  |
| ------------------------------------------ | ------------------------------------------------------ |
| Orchestrator source                        | `orchestrator/src/`                                    |
| Task YAMLs (this repo)                     | `tasks/HARNESS-*.yaml`                                 |
| Task YAMLs (live, watched by orchestrator) | `/Users/josh/claude/pkb/projects/agent-harness/tasks/` |
| Sub-agent worktrees                        | `/Users/josh/claude/pkb/projects/worktrees/`           |
| Smoke project                              | `projects/smoke/`                                      |
| Fake agent script                          | `scripts/fake-agent.sh`                                |
| Integration test                           | `test/integration/first-task.test.ts`                  |

**Note:** The orchestrator (docker) watches the pkb path, not this repo's
`tasks/` directory. When dispatching tasks, copy YAMLs from `tasks/` to
`/Users/josh/claude/pkb/projects/agent-harness/tasks/`.

---

## How to pick up

1. Write `.claude/skills/setup/SKILL.md` (see requirements above)
2. Test it with `/setup` in a fresh terminal in this repo
3. Run skill-creator evals in Claude.ai
4. Optionally fix the integration test (see item 2 above)
