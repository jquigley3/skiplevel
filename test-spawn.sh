#!/usr/bin/env bash
# Test the spawn_task tool: parent spawns two poem tasks, picks favourite.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Use /tmp as the project dir (poems don't need a real repo)
PROJECT_DIR="/tmp/mc2-test-poems"
mkdir -p "$PROJECT_DIR"

PROMPT='Your goal:
1. Spawn two sub-tasks. Task 1 prompt: "Write a short poem (4-8 lines) about the ocean." Task 2 prompt: "Write a short poem (4-8 lines) about a forest."
2. Poll their status every 10 seconds until both are done.
3. Read the result_text from each completed task.
4. Pick your favourite poem and explain why in two sentences.'

"$SCRIPT_DIR/submit.sh" "$PROJECT_DIR" "$PROMPT" \
  --tools spawn_task \
  --append-system-prompt-file "$SCRIPT_DIR/developer/tools.md"

echo ""
echo "Monitor progress:  ./list.sh"
echo "Orchestrator logs: ./dev.sh logs"
