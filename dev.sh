#!/usr/bin/env bash
# Agent Harness — developer CLI
#
# Usage:
#   ./dev.sh rebuild              # Rebuild ALL images (no cache) and restart
#   ./dev.sh restart              # Restart services without rebuilding
#   ./dev.sh stop                 # Stop all services
#   ./dev.sh logs                 # Tail orchestrator logs
#   ./dev.sh status               # Show containers + proxy stats
#   ./dev.sh dispatch <TASK-ID>   # Set task status to assigned (queue it)
#   ./dev.sh token                # Refresh OAuth token from macOS Keychain

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yaml"
CONTAINER_DIR="$SCRIPT_DIR/container"
TASKS_DIR="$SCRIPT_DIR/tasks"
IMAGE_NAME="agent-harness:latest"

# ── Helpers ──────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" &>/dev/null || die "$1 is required but not installed"; }

proxy_stats() {
  curl -sf http://localhost:8001 | python3 -m json.tool 2>/dev/null \
    || echo "(proxy not reachable)"
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_rebuild() {
  echo "==> Stopping services..."
  docker compose -f "$COMPOSE_FILE" down

  echo "==> Building sub-agent container image (no cache)..."
  docker build --no-cache -t "$IMAGE_NAME" "$CONTAINER_DIR"

  echo "==> Building proxy and orchestrator images (no cache)..."
  docker compose -f "$COMPOSE_FILE" build --no-cache

  echo "==> Starting services..."
  docker compose -f "$COMPOSE_FILE" up -d

  echo ""
  docker compose -f "$COMPOSE_FILE" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
  echo ""
  echo "Logs:   ./dev.sh logs"
  echo "Status: ./dev.sh status"
}

cmd_restart() {
  echo "==> Restarting services..."
  docker compose -f "$COMPOSE_FILE" down
  docker compose -f "$COMPOSE_FILE" up -d
  echo ""
  docker compose -f "$COMPOSE_FILE" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
}

cmd_stop() {
  echo "==> Stopping services..."
  docker compose -f "$COMPOSE_FILE" down
}

cmd_logs() {
  echo "==> Tailing orchestrator logs (Ctrl+C to stop — services keep running)..."
  docker logs -f agent-harness-orchestrator
}

cmd_status() {
  echo "==> Containers:"
  docker compose -f "$COMPOSE_FILE" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
  echo ""
  echo "==> Proxy stats (http://localhost:8001):"
  proxy_stats
}

cmd_dispatch() {
  local task_id="${1:-}"
  [ -n "$task_id" ] || die "Usage: ./dev.sh dispatch <TASK-ID>"

  local task_file="$TASKS_DIR/${task_id}.yaml"
  [ -f "$task_file" ] || die "Task file not found: $task_file"

  # Refresh OAuth token from Keychain so the orchestrator picks it up fresh.
  # The orchestrator re-reads .env at each dispatch — no restart needed.
  echo "==> Refreshing OAuth token..."
  cmd_token

  # Set task status to assigned
  sed -i '' 's/^status:.*/status: assigned/' "$task_file"

  local new_ts
  new_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  sed -i '' "s/^updated:.*/updated: $new_ts/" "$task_file"

  echo "==> Dispatched: $task_id (status: assigned)"
  echo "    Watch: ./dev.sh logs"
}

cmd_token() {
  need security
  echo "==> Extracting OAuth token from macOS Keychain..."
  local raw
  raw="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)" \
    || die "Token not found in Keychain. Log in to Claude Code first: claude login"

  # The keychain password is a JSON blob: {"claudeAiOauth":{"accessToken":"sk-ant-oat01-...",...}}
  # Extract just the access token string for CLAUDE_CODE_OAUTH_TOKEN.
  local token
  token="$(printf '%s' "$raw" | python3 -c "
import sys, json
data = json.load(sys.stdin)
# Support both known key names
for key in ('claudeAiOauth', 'claudeAiOAuthToken'):
    val = data.get(key)
    if isinstance(val, dict):
        print(val.get('accessToken', ''))
        break
    elif isinstance(val, str):
        print(val)
        break
" 2>/dev/null)"

  # Fallback: if JSON parsing failed, use the raw value (older plain-token format)
  if [ -z "$token" ]; then
    token="$raw"
  fi

  local env_file="$SCRIPT_DIR/orchestrator/.env"
  if grep -q "CLAUDE_CODE_OAUTH_TOKEN" "$env_file"; then
    sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$token|" "$env_file"
  else
    echo "CLAUDE_CODE_OAUTH_TOKEN=$token" >> "$env_file"
  fi

  echo "==> Token updated in orchestrator/.env"
  echo "    Restart to apply: ./dev.sh restart"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────

CMD="${1:-}"
shift || true

case "$CMD" in
  rebuild)  cmd_rebuild ;;
  restart)  cmd_restart ;;
  stop)     cmd_stop ;;
  logs)     cmd_logs ;;
  status)   cmd_status ;;
  dispatch) cmd_dispatch "$@" ;;
  token)    cmd_token ;;
  *)
    echo "Usage: ./dev.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  rebuild              Rebuild ALL images (no cache) and restart"
    echo "  restart              Restart services without rebuilding"
    echo "  stop                 Stop all services"
    echo "  logs                 Tail orchestrator logs"
    echo "  status               Show containers and proxy stats"
    echo "  dispatch <TASK-ID>   Queue a task (set status: assigned)"
    echo "  token                Refresh OAuth token from macOS Keychain"
    exit 1
    ;;
esac
