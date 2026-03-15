#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

die() { echo "ERROR: $*" >&2; exit 1; }

case "${1:-}" in
  build)
    echo "==> Building worker image..."
    docker build -t macro-claw-worker:latest "$SCRIPT_DIR/orchestrator/container"
    echo "==> Building orchestrator..."
    docker compose -f "$SCRIPT_DIR/docker-compose.yaml" build
    ;;
  build-worker)
    echo "==> Building worker image..."
    docker build -t macro-claw-worker:latest "$SCRIPT_DIR/orchestrator/container"
    ;;
  build-dev)
    echo "==> Building dev/test image..."
    docker build -t macro-claw-dev:latest -f "$SCRIPT_DIR/orchestrator/Dockerfile.dev" "$SCRIPT_DIR/orchestrator"
    ;;
  test)
    # Build dev image if it doesn't exist yet
    if ! docker image inspect macro-claw-dev:latest &>/dev/null; then
      "$0" build-dev
    fi
    echo "==> Running tests inside container..."
    docker run --rm \
      -v "$SCRIPT_DIR/orchestrator:/app" \
      -v "/app/node_modules" \
      macro-claw-dev:latest \
      npx tsx --test test/smoke.test.ts
    ;;
  typecheck)
    # Build dev image if it doesn't exist yet
    if ! docker image inspect macro-claw-dev:latest &>/dev/null; then
      "$0" build-dev
    fi
    echo "==> Type-checking inside container..."
    docker run --rm \
      -v "$SCRIPT_DIR/orchestrator:/app" \
      -v "/app/node_modules" \
      macro-claw-dev:latest \
      npm run typecheck
    ;;
  up)
    # Ensure network exists
    docker network create macro-claw-net 2>/dev/null || true

    # Run orchestrator (no fixed --name to avoid restart issues)
    docker run -d \
      --network macro-claw-net \
      -v "$SCRIPT_DIR/orchestrator/data:/app/data" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$SCRIPT_DIR/.env:/app/.env:ro" \
      --env-file "$SCRIPT_DIR/.env" \
      -e CREDENTIAL_PROXY_PORT=3001 \
      -e CREDENTIAL_PROXY_HOST=0.0.0.0 \
      -e CONTAINER_IMAGE=macro-claw-worker:latest \
      -e HARNESS_NETWORK=macro-claw-net \
      -e WORKTREES_DIR=/workspace/worktrees \
      -e HOST_WORKTREES_DIR=./worktrees \
      mc2-orchestrator

    sleep 2
    ORCH_ID=$(docker ps -f ancestor=mc2-orchestrator -q | head -1)
    if [ -n "$ORCH_ID" ]; then
      echo "Orchestrator started: $ORCH_ID"
      docker logs "$ORCH_ID" 2>&1 | tail -10
    else
      echo "WARNING: Orchestrator may have failed to start"
      docker ps -a | grep mc2-orchestrator || true
    fi
    ;;
  down)
    docker ps -f ancestor=mc2-orchestrator -q | xargs -r docker rm -f
    docker network rm macro-claw-net 2>/dev/null || true
    ;;
  logs)
    docker logs -f macro-claw-orchestrator
    ;;
  token)
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
    echo "  build         Build all Docker images"
    echo "  build-worker  Build only the worker image"
    echo "  build-dev     Build the dev/test image"
    echo "  test          Run tests inside a container (no host deps needed)"
    echo "  typecheck     Run TypeScript type-check inside a container"
    echo "  up            Start orchestrator"
    echo "  down          Stop orchestrator"
    echo "  logs          Tail orchestrator logs"
    echo "  token         Refresh OAuth token from macOS Keychain"
    echo "  rebuild       Stop, build, start"
    exit 1
    ;;
esac
