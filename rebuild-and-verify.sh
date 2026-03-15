#!/usr/bin/env bash
# Rebuild everything, bounce the stack, and verify it's healthy.
# Use after modifying code — gives useful output if something fails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
MC2_API="${MC2_API_URL:-http://localhost:3001}"

echo "==> Rebuild and verify"
echo ""

# 1. Rebuild
echo "[1/4] Building images..."
if ! ./dev.sh build; then
  echo ""
  echo "❌ BUILD FAILED"
  echo "Fix build errors above. Common issues:"
  echo "  - TypeScript errors: run 'cd orchestrator && npm run typecheck'"
  echo "  - Missing deps: run 'cd orchestrator && npm install'"
  exit 1
fi
echo ""

# 2. Bounce stack
echo "[2/4] Stopping stack..."
./dev.sh down 2>/dev/null || true
# Fallback: stop any container using port 3001 (e.g. orphaned from previous build)
for cid in $(docker ps -q --filter "publish=3001" 2>/dev/null); do
  docker rm -f "$cid" 2>/dev/null || true
done
sleep 2

echo "[3/4] Starting orchestrator..."
if ! ./dev.sh up; then
  echo ""
  echo "❌ START FAILED"
  echo ""
  echo "Recent orchestrator logs:"
  ORCH_ID=$(docker ps -a -f ancestor=mc2-orchestrator --format '{{.ID}}' | head -1)
  [[ -n "$ORCH_ID" ]] && docker logs --tail 50 "$ORCH_ID" 2>&1 || true
  echo ""
  echo "All containers:"
  docker ps -a
  exit 1
fi
echo ""

# 3. Wait for proxy to be ready
echo "[4/4] Verifying health..."
for i in $(seq 1 15); do
  if curl -sf "$MC2_API/health" >/dev/null 2>&1; then
    break
  fi
  if [[ $i -eq 15 ]]; then
    echo ""
    echo "❌ HEALTH CHECK FAILED — /health did not respond within 15s"
    echo ""
    echo "Orchestrator logs (last 80 lines):"
    ORCH_ID=$(docker ps -a -f ancestor=mc2-orchestrator --format '{{.ID}}' | head -1)
    if [[ -n "$ORCH_ID" ]]; then
      docker logs --tail 80 "$ORCH_ID" 2>&1
    else
      echo "  (no orchestrator container found)"
    fi
    echo ""
    echo "Container status:"
    docker ps -a
    echo ""
    echo "Things to check:"
    echo "  - Port 3001 in use? Run: lsof -i :3001"
    echo "  - Stale container? Run: docker ps -a | grep 3001; docker rm -f <container_id>"
    echo "  - Check .env has ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
    echo "  - Run './dev.sh logs' to stream logs"
    exit 1
  fi
  sleep 1
done

# 4. Verify API responds
HEALTH=$(curl -sf "$MC2_API/health")
if ! echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('ok') else 1)" 2>/dev/null; then
  echo ""
  echo "❌ HEALTH RESPONSE INVALID"
  echo "Response: $HEALTH"
  exit 1
fi

# Quick API smoke test
if ! curl -sf "$MC2_API/api/jobs?limit=1" >/dev/null 2>&1; then
  echo ""
  echo "⚠️  /health OK but /api/jobs failed — stack may be partially up"
  echo "   Check './dev.sh logs' for errors"
  exit 1
fi

echo ""
echo "✅ Stack healthy"
echo "   Health: $HEALTH"
echo "   API: $MC2_API"
echo ""
echo "Ready for jobs. Try: ./submit.sh /path/to/project \"Your prompt\""
