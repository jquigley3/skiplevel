---
name: setup
description: >
  Initialize macro-claw for first-time use. Checks prerequisites (Docker,
  Node, credentials), installs dependencies, builds container images, and
  verifies the orchestrator is ready to dispatch tasks. Use for initial
  setup, environment verification, or diagnosing a broken install.
allowed-tools: Bash, Read, Write, Glob
---

## Environment State

!`docker info >/dev/null 2>&1 && echo OK || echo "NOT RUNNING"`
!`node --version 2>/dev/null | grep -q 'v' && node --version || echo MISSING`
!`test -f orchestrator/.env && echo OK || echo MISSING`
!`test -f .env && echo OK || echo MISSING`
!`grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=.+' orchestrator/.env 2>/dev/null && echo OK || echo MISSING`
!`docker image inspect agent-harness:latest >/dev/null 2>&1 && echo OK || echo MISSING`
!`docker ps --filter name=agent-harness-orchestrator --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q agent-harness-orchestrator && echo RUNNING || echo "NOT RUNNING"`
!`docker ps --filter name=agent-harness-proxy --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q agent-harness-proxy && echo RUNNING || echo "NOT RUNNING"`

The lines above (in order) show the current state of:

1. Docker daemon: OK or NOT RUNNING
2. Node.js: version string or MISSING
3. `orchestrator/.env`: OK or MISSING
4. `.env`: OK or MISSING
5. Credentials in `orchestrator/.env`: OK or MISSING
6. `agent-harness:latest` image: OK or MISSING
7. Orchestrator container (`agent-harness-orchestrator`): RUNNING or NOT RUNNING
8. Proxy container (`agent-harness-proxy`): RUNNING or NOT RUNNING

---

## Instructions

If `$ARGUMENTS` contains `--check-only`:

- Report the environment summary using the state above.
- Use ✓ for OK/RUNNING and ✗ for MISSING/NOT RUNNING items.
- Stop here. Take no action.

Otherwise, work through the setup checklist below in order, stopping at any
blocker that requires user action:

### Step 1 — Docker

If Docker is NOT RUNNING:

- Tell the user Docker must be installed and running before setup can continue.
- Show ✗ Docker — not running. Start Docker Desktop (macOS) or `sudo systemctl start docker` (Linux).
- Stop.

### Step 2 — Node.js

If Node is MISSING:

- Tell the user: ✗ Node.js — not found. Install Node 18+ from https://nodejs.org or via `brew install node`.
- Continue checking the rest of the environment (don't stop, this is informational).

### Step 3 — `orchestrator/.env`

If `orchestrator/.env` is MISSING:

- Copy `orchestrator/.env.example` to `orchestrator/.env` using the Bash tool:
  ```
  cp orchestrator/.env.example orchestrator/.env
  ```
- Tell the user:
  > ⚠ `orchestrator/.env` was missing and has been created from `.env.example`.
  > You must edit it and add your credentials before continuing:
  >
  > `ANTHROPIC_API_KEY=sk-ant-...`
  > or
  > `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...`
  >
  > Re-run `/setup` after saving your credentials.
- Stop here. Do not proceed past a missing credentials file.

### Step 4 — Credentials

If credentials are MISSING (step 5 above showed MISSING):

- Tell the user:
  > ✗ Credentials — `orchestrator/.env` exists but no valid `ANTHROPIC_API_KEY`
  > or `CLAUDE_CODE_OAUTH_TOKEN` found.
  >
  > Edit `orchestrator/.env` and set one of:
  > `ANTHROPIC_API_KEY=sk-ant-...`
  > `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...`
  >
  > Re-run `/setup` after saving.
- Stop here.

### Step 5 — npm dependencies

Check whether `orchestrator/node_modules` exists:

!`test -d orchestrator/node_modules && echo OK || echo MISSING`

If MISSING, run:

```bash
cd orchestrator && npm install
```

### Step 6 — Container images

If `agent-harness:latest` image is MISSING, run:

```bash
docker compose build
```

This builds all services defined in `docker-compose.yaml`.

### Step 7 — Start orchestrator

If orchestrator or proxy containers are NOT RUNNING, run:

```bash
docker compose up -d
```

### Step 8 — Verify

After completing the action steps, re-check the live state:

!`docker ps --filter name=agent-harness-orchestrator --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q agent-harness-orchestrator && echo RUNNING || echo "NOT RUNNING"`
!`docker ps --filter name=agent-harness-proxy --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q agent-harness-proxy && echo RUNNING || echo "NOT RUNNING"`
!`curl -sf http://localhost:8001 >/dev/null 2>&1 && echo OK || echo "NOT REACHABLE"`

Report:

- Orchestrator container: RUNNING or NOT RUNNING
- Proxy container: RUNNING or NOT RUNNING
- Proxy stats endpoint (http://localhost:8001): OK or NOT REACHABLE

### Step 9 — Readiness summary

Print a final summary. Use ✓ for passing checks and ✗ for failures, each with a one-line
reason and fix hint if failed. Example of a fully-green output:

```
✓ Docker running
✓ Node 22.x found
✓ orchestrator/.env exists
✓ Credentials present
✓ agent-harness:latest image built
✓ Orchestrator running
✓ Proxy running
✓ Proxy stats endpoint reachable

Ready. Dispatch your first task:
  ./dev.sh dispatch SMOKE-001
```

If any check failed:

```
✗ [thing] — [one-line reason] — [how to fix]
```

For failures, tell the user which step to take next, or that they need to re-run
`/setup` after resolving the issue.
