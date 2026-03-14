#!/usr/bin/env bash
# Agent Harness — launch script
#
# Builds all images and starts the proxy + orchestrator together.
# Sub-agents are spawned dynamically by the orchestrator.
#
# Usage:
#   ./start.sh          # Start everything, tail logs
#   ./start.sh --detach # Start in background (no log tail)
#   ./start.sh --stop   # Stop all services
#   ./start.sh --status # Show running containers and proxy stats

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yaml"
DETACH=false

# ── Argument parsing ─────────────────────────────────────────────────────────

case "${1:-}" in
  --stop)
    echo "==> Stopping agent harness..."
    docker compose -f "$COMPOSE_FILE" down
    exit 0
    ;;
  --status)
    echo "==> Running containers:"
    docker compose -f "$COMPOSE_FILE" ps
    echo ""
    echo "==> Proxy stats (http://localhost:8001):"
    curl -sf http://localhost:8001 | python3 -m json.tool 2>/dev/null \
      || echo "(proxy not reachable)"
    exit 0
    ;;
  --detach|-d)
    DETACH=true
    ;;
  "")
    ;;
  *)
    echo "Usage: $0 [--detach | --stop | --status]"
    exit 1
    ;;
esac

# ── Build ────────────────────────────────────────────────────────────────────

echo "==> Building sub-agent container image..."
"$SCRIPT_DIR/container/build.sh"

echo "==> Building proxy and orchestrator images..."
docker compose -f "$COMPOSE_FILE" build

# ── Start ────────────────────────────────────────────────────────────────────

echo "==> Starting proxy and orchestrator..."
docker compose -f "$COMPOSE_FILE" up -d

echo ""
echo "Services:"
docker compose -f "$COMPOSE_FILE" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "Proxy stats:        http://localhost:8001"
echo "Stop:               ./start.sh --stop"
echo "Status:             ./start.sh --status"
echo ""

if [ "$DETACH" = true ]; then
  echo "Running in background. Attach logs with:"
  echo "  docker compose -f $COMPOSE_FILE logs -f"
else
  echo "Tailing logs (Ctrl+C to detach — services keep running)..."
  docker compose -f "$COMPOSE_FILE" logs -f
fi
