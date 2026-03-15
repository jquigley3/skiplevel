---
name: setup
description: >
  Initialize macro-claw and verify environment readiness. Checks prerequisites (Docker, credentials), builds container images, and validates the orchestrator. Use whenever: (1) setting up macro-claw for the first time, (2) troubleshooting why the orchestrator won't start or isn't responding, (3) verifying your environment is ready before submitting jobs, (4) diagnosing broken installations, or (5) performing environment checks with --status. Also use for partial setups—if you're unsure what's missing or broken, this skill will pinpoint it with actionable fixes.
allowed-tools: Bash, Read, Write, Glob
---

## Environment Probe

Gather current state before doing anything. Each line produces a single token
that the instructions below match on.

!`docker info >/dev/null 2>&1 && echo DOCKER_OK || echo DOCKER_MISSING`
!`test -f .env && echo DOTENV_OK || echo DOTENV_MISSING`
!`grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=.+' .env 2>/dev/null && echo CREDS_OK || echo CREDS_MISSING`
!`docker image inspect macro-claw-worker:latest >/dev/null 2>&1 && echo WORKER_IMAGE_OK || echo WORKER_IMAGE_MISSING`
!`docker image inspect mc2-orchestrator:latest >/dev/null 2>&1 && echo ORCH_IMAGE_OK || echo ORCH_IMAGE_MISSING`
!`docker ps --filter ancestor=mc2-orchestrator:latest --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q . && echo ORCH_RUNNING || echo ORCH_STOPPED`

The lines above (in order) show:
1. Docker daemon
2. `.env` file at project root
3. Credentials in `.env` (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`)
4. `macro-claw-worker:latest` Docker image
5. Orchestrator Docker image
6. Orchestrator container running

---

## Instructions

### Check-only mode

If `$ARGUMENTS` contains `--check` or `--check-only` or `--status`:
- Report the environment summary using the probe results above.
- Use a checkmark for passing items and an X for failing items.
- For each failed item, provide the fix command.
- At the end, state: "✅ Ready to submit jobs" (if all pass) OR "⚠️ Blocked on [item]" (if failures exist)
- Do NOT take any action. Stop here.

### Full setup mode (default)

Work through the checklist below in order. Stop at any blocker that requires
user action. After each action step, report what you did.

**Estimated time:**
- Fresh start (all missing): ~15–20 minutes (mostly Docker image builds)
- Credentials only missing: ~2 minutes
- Just verification: <1 minute

#### Step 1 — Docker

If `DOCKER_MISSING`:
- Print: Docker is not running. Install Docker Desktop (macOS) or start
  the daemon (`sudo systemctl start docker` on Linux).
- Stop. Nothing else can proceed without Docker.

#### Step 2 — .env file

If `DOTENV_MISSING`:
- Copy `.env.example` to `.env`:
  ```
  cp .env.example .env
  ```
- Print: `.env` created from `.env.example`. You must add credentials
  before continuing.

#### Step 3 — Credentials

If `CREDS_MISSING`:
- Determine whether the user likely has an API key or uses OAuth.
  Check if `claude` CLI is installed and if macOS Keychain has a token:

!`command -v claude >/dev/null 2>&1 && echo CLAUDE_CLI_OK || echo CLAUDE_CLI_MISSING`
!`security find-generic-password -s "Claude Code-credentials" -w >/dev/null 2>&1 && echo KEYCHAIN_OK || echo KEYCHAIN_MISSING`

- If `KEYCHAIN_OK` (macOS with Claude Code logged in):
  Offer to extract the OAuth token automatically:
  > Found Claude Code credentials in macOS Keychain. Extract and write
  > to `.env`? This runs `./dev.sh token`.

  If the user agrees (or if `$ARGUMENTS` contains `--auto`), run:
  ```bash
  ./dev.sh token
  ```

- If `KEYCHAIN_MISSING`:
  Print instructions for both options:
  > No credentials found in `.env`. Set one of:
  >
  > **Option A — API key** (recommended for CI / headless):
  > ```
  > echo 'ANTHROPIC_API_KEY=sk-ant-api03-...' >> .env
  > ```
  >
  > **Option B — OAuth token** (personal use, macOS):
  > 1. Run `claude login` to authenticate
  > 2. Run `./dev.sh token` to extract the token to `.env`
  >
  > Re-run `/setup` after adding credentials.

  Stop here.

#### Step 4 — Build images

If `WORKER_IMAGE_MISSING` or `ORCH_IMAGE_MISSING`:
- Run:
  ```bash
  ./dev.sh build
  ```
- This builds both the worker image (`macro-claw-worker:latest`) and the
  orchestrator image using the docker-compose.yaml configuration. Report result.

#### Step 5 — Start orchestrator

If `ORCH_STOPPED`:
- Run:
  ```bash
  ./dev.sh up
  ```
- Report result.

#### Step 6 — Verify

After completing action steps, re-probe live state:

!`docker ps --filter ancestor=mc2-orchestrator:latest --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q . && echo ORCH_RUNNING || echo ORCH_STOPPED`
!`curl -sf http://localhost:3001/api/jobs >/dev/null 2>&1 && echo PROXY_OK || echo PROXY_UNREACHABLE`
!`test -f orchestrator/data/macro-claw.db && echo DB_OK || echo DB_MISSING`

Report:
- Orchestrator container: running or stopped
- Credential proxy (port 3001): reachable or not
- SQLite database: created or missing

#### Step 7 — Summary

Print a final checklist. Use a checkmark for passing and X for failing.
Include a one-line fix hint for any failures.

**If all items pass:**
```
✅ Setup Complete — Ready to Submit Jobs

  [ok] Docker running
  [ok] .env exists
  [ok] Credentials configured
  [ok] Worker image built
  [ok] Orchestrator image built
  [ok] Orchestrator running
  [ok] Credential proxy reachable
  [ok] Database initialized

You can now submit your first job:
  ./submit.sh /path/to/project "Describe the codebase"

Your environment is fully configured and ready.
```

**If any failures exist:**
```
⚠️ Setup Blocked — Fix Required

  [ok] Docker running
  [FAIL] Credentials configured — ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN not set in .env
         → Fix: echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env
         → Then re-run: /setup

  [not checked] Worker image built
  [not checked] Orchestrator image built
  [not checked] Orchestrator running

One or more prerequisites are missing. Fix the items above and re-run /setup.
```
