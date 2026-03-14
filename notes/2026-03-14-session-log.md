# Session Log: 2026-03-14

## Bootstrap Session

First session building the agent harness. Host agent (this Claude CLI) running on macOS, sub-agents in Docker containers.

### What was accomplished

1. **Apple sandbox attempted, abandoned** — `sandbox-exec` SBPL `param` syntax crashes on file-based profiles. Switched to Docker containers (NanoClaw model).

2. **Docker container working** — `container/Dockerfile` (node:22-slim + Claude Code via npm), `container/run.sh` launcher, `container/build.sh`.

3. **Auth solved** — OAuth token extracted from macOS keychain (`security find-generic-password -s "Claude Code-credentials" -w`), JSON parsed for `claudeAiOauth.accessToken`, passed as `CLAUDE_CODE_OAUTH_TOKEN` env var. Containers never see host config files.

4. **IPC protocol established** — file-based mailbox in `ipc/` directory: host writes `task.md`, sub-agent writes `status.md` and `result.md`.

5. **First delegation successful** — HARNESS-001 (design state model) completed by sub-agent. Produced `project.yaml`, `tasks/*.yaml`, `resources.yaml`, design rationale.

6. **Second project added** — complaint-automator. CA-001 (scaffold Next.js + Drizzle schema) completed by sub-agent.

### Key decisions

- Top-level agent runs on host (needs Docker access); sub-agents run in containers
- `--dangerously-skip-permissions` is default for sub-agents (container IS the sandbox)
- Auth: keychain extraction, not credential proxy (simpler than NanoClaw's approach for MVP)
- IPC: files on shared mount, not git (ephemeral task communication)
- Git for sharing project state across agents over time

### Sub-agent outputs

- HARNESS-001 result: `ipc/result.md` (state model design)
- CA-001 result: `complaint-automator/ipc/result.md` (scaffold summary)
