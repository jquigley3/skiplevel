# macro-claw — Orchestrator for Claude Code

A job orchestrator that runs Claude Code in isolated Docker containers with a credential proxy for secure API access.

## Quick Start

### Prerequisites
- Docker (with socket access)
- Node.js 18+
- `.env` file with `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (see `.env.example`)

### Setup and Run

```bash
# Build images
./dev.sh build

# Start orchestrator
./dev.sh up

# In another terminal, submit a job
./submit.sh /path/to/project "Your prompt here"

# Check job status
./result.sh <job-id>

# View orchestrator logs
./dev.sh logs

# Stop orchestrator
./dev.sh down
```

## Architecture

**Orchestrator** (Node.js):
- Polls SQLite job queue
- Creates git worktrees for isolation
- Spawns worker containers
- Captures transcripts and results
- Runs a credential proxy on port 3001

**Workers** (Docker):
- Run `claude` CLI in isolated containers
- Connect to credential proxy at `macro-claw-orchestrator:3001`
- Can read/write to project worktrees

**Credential Proxy**:
- HTTP proxy running inside orchestrator
- Injects real API credentials on every request
- Workers never see the real credentials

## Job Submission

Jobs are submitted directly to SQLite:

```bash
DB_PATH=./orchestrator/data/macro-claw.db sqlite3 \
  "INSERT INTO jobs (id, prompt, project_dir, priority)
   VALUES (uuid(), 'Your prompt', '/path/to/project', 0);"
```

Or use the convenience script:

```bash
./submit.sh /path/to/project "Your prompt"
```

## Documentation

See `plan/` directory for detailed architecture:
- `01-setup.md` — Project initialization
- `03-orchestrator.md` — Main loop and job dispatch
- `05-credentials.md` — Credential handling
- `06-docker.md` — Container networking and setup

## Networking

Workers and orchestrator communicate over Docker's bridge network `macro-claw-net`. Workers reach the credential proxy using container name DNS: `http://macro-claw-orchestrator:3001`.

## Database

SQLite database at `./orchestrator/data/macro-claw.db` tracks job status, results, and transcripts.

## Troubleshooting

**Orchestrator won't start:**
```bash
./dev.sh logs
docker ps -a | grep orchestrator
```

**Job stuck in "running" state:**
- Check orchestrator logs for errors
- Verify worker container ran: `docker ps -a | grep macro-claw-`

**Worker can't reach proxy:**
- Verify both containers are on `macro-claw-net`: `docker network inspect macro-claw-net`
- Check `ANTHROPIC_BASE_URL` is set correctly in worker container

## Development

```bash
# Type-check
./dev.sh typecheck

# Run tests
./dev.sh test

# Rebuild (clean)
./dev.sh rebuild
```
