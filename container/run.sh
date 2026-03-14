#!/usr/bin/env bash
# Launch a sandboxed Claude Code CLI session in a Docker container.
#
# Usage:
#   ./run.sh <project-dir> [claude args...]
#
# Mounts:
#   - <project-dir>  → /workspace/project (read/write)
#   - PKB            → /workspace/pkb     (read-only)
#
# Auth: extracts OAuth token from macOS keychain and passes as env var.
#       Falls back to ANTHROPIC_API_KEY if set. No host config files mounted.

set -euo pipefail

IMAGE_NAME="agent-harness"
PKB_DIR="/Users/josh/claude/pkb"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <project-dir> [claude args...]"
  echo ""
  echo "Examples:"
  echo "  $0 /Users/josh/claude/pkb/projects/agent-harness"
  echo "  $0 /Users/josh/claude/pkb/projects/agent-harness --print 'list files'"
  echo "  $0 /Users/josh/claude/pkb/projects/agent-harness -p 'do the task then exit'"
  exit 1
fi

PROJECT_DIR="$(cd "$1" && pwd)"
shift

# Check image exists
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Image '$IMAGE_NAME' not found. Building..."
  "$(dirname "$0")/build.sh"
fi

# Container name based on project dir basename + timestamp
PROJECT_NAME="$(basename "$PROJECT_DIR")"
CONTAINER_NAME="harness-${PROJECT_NAME}-$(date +%s)"

# Resolve auth: env var > macOS keychain
AUTH_ARGS=()
AUTH_SOURCE=""
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  AUTH_ARGS+=(-e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
  AUTH_SOURCE="ANTHROPIC_API_KEY env var"
else
  # Keychain entry is JSON: {"claudeAiOauth":{"accessToken":"sk-ant-oat-...","refreshToken":...}}
  KEYCHAIN_TOKEN="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null || true)"
  if [[ -n "$KEYCHAIN_TOKEN" ]]; then
    AUTH_ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=${KEYCHAIN_TOKEN}")
    AUTH_SOURCE="macOS keychain (Claude Code OAuth)"
  else
    echo "Error: No auth found."
    echo "  - Set ANTHROPIC_API_KEY, or"
    echo "  - Run 'claude login' on the host to populate the keychain"
    exit 1
  fi
fi

echo "=== Agent Harness: Sandboxed Claude Code ==="
echo "Project:   $PROJECT_DIR → /workspace/project (rw)"
echo "PKB:       $PKB_DIR → /workspace/pkb (ro)"
echo "Auth:      $AUTH_SOURCE"
echo "Container: $CONTAINER_NAME"
echo "============================================="
echo ""
echo "The container will have read/write access to:"
echo "  $PROJECT_DIR"
echo ""
read -r -p "Continue? [Y/n] " response
if [[ "$response" =~ ^[Nn] ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

exec docker run -it --rm \
  --name "$CONTAINER_NAME" \
  -v "$PROJECT_DIR:/workspace/project" \
  -v "$PKB_DIR:/workspace/pkb:ro" \
  "${AUTH_ARGS[@]}" \
  "$IMAGE_NAME" \
  --dangerously-skip-permissions \
  "$@"
