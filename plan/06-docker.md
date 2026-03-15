# 06 — Docker Setup

## Container Image (Worker)

The worker container image is kept from nano-claw with minimal changes. It installs Claude Code CLI on top of node:22-slim.

### container/Dockerfile

```dockerfile
# macro-claw worker — sandboxed Claude Code CLI
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Workspace directories
RUN mkdir -p /workspace/project /home/node/.claude

# Git identity for agent commits
RUN git config --global user.name "macro-claw-worker" \
    && git config --global user.email "worker@macro-claw.local"

# Entrypoint: write .claude.json then exec claude
RUN printf '#!/bin/sh\nif [ ! -f /home/node/.claude.json ]; then\n  echo '\''{"installMethod":"npm"}'\'' > /home/node/.claude.json\nfi\nexec claude "$@"\n' > /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

RUN chown -R node:node /workspace /home/node

USER node
WORKDIR /workspace/project

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

### Build the image

```bash
docker build -t macro-claw-worker:latest ./container
```

## Orchestrator Dockerfile

The orchestrator runs as a Node.js app inside Docker with access to the Docker socket (to spawn sibling worker containers).

### orchestrator/Dockerfile

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (to spawn sibling containers)
RUN curl -fsSL https://get.docker.com | sh

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Data directory for SQLite
RUN mkdir -p /app/data

CMD ["node", "dist/orchestrator.js"]
```

## Docker Compose

The compose file runs the orchestrator and gives it access to the Docker socket.

### docker-compose.yaml

```yaml
# macro-claw — orchestrator
#
# Usage:
#   docker compose up -d          # Start
#   docker compose logs -f        # Watch logs
#   docker compose down           # Stop

services:
  orchestrator:
    build: ./orchestrator
    container_name: macro-claw-orchestrator
    restart: unless-stopped
    networks:
      - macro-claw-net
    volumes:
      # Docker socket — orchestrator spawns sibling worker containers
      - /var/run/docker.sock:/var/run/docker.sock
      # Worktrees directory — shared between orchestrator and workers
      - ${HOST_WORKTREES_DIR:-./worktrees}:/workspace/worktrees
      # Persistent data (SQLite DB)
      - macro-claw-data:/app/data
      # .env mounted live so credential proxy re-reads fresh OAuth tokens
      - ./.env:/app/.env:ro
    ports:
      # Credential proxy — workers reach it via host.docker.internal:3001
      - '3001:3001'
    environment:
      - WORKTREES_DIR=/workspace/worktrees
      - HOST_WORKTREES_DIR=${HOST_WORKTREES_DIR:-./worktrees}
      - CONTAINER_IMAGE=macro-claw-worker:latest
      - HARNESS_NETWORK=macro-claw-net
      - CREDENTIAL_PROXY_HOST=0.0.0.0
      - LOG_LEVEL=${LOG_LEVEL:-info}
      - MAX_CONCURRENT_WORKERS=${MAX_CONCURRENT_WORKERS:-1}
    env_file:
      - .env

networks:
  macro-claw-net:
    name: macro-claw-net
    driver: bridge

volumes:
  macro-claw-data:
```

## Networking

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Host                          │
│                                                         │
│  ┌─────────────────────────────────────────────┐        │
│  │  macro-claw-net (bridge network)            │        │
│  │                                              │        │
│  │  ┌──────────────────────┐                   │        │
│  │  │  orchestrator         │                   │        │
│  │  │  - credential proxy   │◄──────────────── │ ◄── port 3001
│  │  │    :3001              │  API requests     │        │
│  │  │  - polls SQLite       │  from workers     │        │
│  │  │  - spawns workers     │                   │        │
│  │  └──────────┬───────────┘                   │        │
│  │             │ docker run                     │        │
│  │  ┌──────────▼───────────┐                   │        │
│  │  │  worker-<jobid>       │                   │        │
│  │  │  - claude CLI         │                   │        │
│  │  │  - ANTHROPIC_BASE_URL │                   │        │
│  │  │    =host.docker.      │                   │        │
│  │  │    internal:3001      │                   │        │
│  │  └──────────────────────┘                   │        │
│  └─────────────────────────────────────────────┘        │
│                         │                               │
│                         │ https                          │
│                         ▼                               │
│                api.anthropic.com                        │
└─────────────────────────────────────────────────────────┘
```

Workers join `macro-claw-net` via `--network macro-claw-net` in their Docker run args. They reach the credential proxy at `host.docker.internal:3001`.

## Host Path Mapping

When the orchestrator runs in Docker, paths differ between the orchestrator container and the Docker host:

| Concept       | Orchestrator sees                                     | Host sees                                     |
| ------------- | ----------------------------------------------------- | --------------------------------------------- |
| Worktrees dir | `/workspace/worktrees`                                | `${HOST_WORKTREES_DIR}` (e.g., `./worktrees`) |
| Project dir   | Passed in `job.project_dir` — must be a **host path** | Same                                          |

**Important**: `job.project_dir` in the database must be an absolute host path, because the orchestrator passes it to `git worktree add` (which runs in the orchestrator container but creates worktrees that workers mount via host paths).

If the orchestrator needs to read the project dir (e.g., to check if it's a git repo), it must have a corresponding mount. For the initial implementation, the simplest approach: mount the project dir into the orchestrator container. Add to docker-compose.yaml:

```yaml
volumes:
  - ${HOST_PROJECTS_DIR}:/workspace/projects:ro
```

And translate paths accordingly. Alternatively, accept that `project_dir` is always a host path and have the orchestrator shell out to `docker exec` — but this is overcomplicating things. The simpler mount approach works.

## dev.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

die() { echo "ERROR: $*" >&2; exit 1; }

case "${1:-}" in
  build)
    echo "==> Building worker image..."
    docker build -t macro-claw-worker:latest "$SCRIPT_DIR/container"
    echo "==> Building orchestrator..."
    docker compose -f "$SCRIPT_DIR/docker-compose.yaml" build
    ;;
  up)
    docker compose -f "$SCRIPT_DIR/docker-compose.yaml" up -d
    docker compose -f "$SCRIPT_DIR/docker-compose.yaml" ps
    ;;
  down)
    docker compose -f "$SCRIPT_DIR/docker-compose.yaml" down
    ;;
  logs)
    docker logs -f macro-claw-orchestrator
    ;;
  token)
    # Extract OAuth token from macOS Keychain (see 05-credentials.md)
    command -v security &>/dev/null || die "macOS 'security' command required"
    raw="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)" \
      || die "Token not found. Run 'claude login' first."
    token="$(printf '%s' "$raw" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for key in ('claudeAiOauth', 'claudeAiOAuthToken'):
    val = data.get(key)
    if isinstance(val, dict):
        print(val.get('accessToken', ''))
        break
    elif isinstance(val, str):
        print(val)
        break
" 2>/dev/null)"
    [ -z "$token" ] && token="$raw"
    env_file="$SCRIPT_DIR/.env"
    if grep -q "CLAUDE_CODE_OAUTH_TOKEN" "$env_file" 2>/dev/null; then
      sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$token|" "$env_file"
    else
      echo "CLAUDE_CODE_OAUTH_TOKEN=$token" >> "$env_file"
    fi
    echo "==> Token updated in .env"
    ;;
  rebuild)
    "$0" down
    "$0" build
    "$0" up
    ;;
  *)
    echo "Usage: ./dev.sh <command>"
    echo "  build     Build all Docker images"
    echo "  up        Start orchestrator"
    echo "  down      Stop orchestrator"
    echo "  logs      Tail orchestrator logs"
    echo "  token     Refresh OAuth token from macOS Keychain"
    echo "  rebuild   Stop, build, start"
    exit 1
    ;;
esac
```
