#!/usr/bin/env bash
# Test the spawn_task capability: parent spawns two poem tasks, picks favourite.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB="${DB_PATH:-$SCRIPT_DIR/orchestrator/data/macro-claw.db}"

# Use /tmp as the project dir (poems don't need a real repo)
PROJECT_DIR="/tmp/mc2-test-poems"
mkdir -p "$PROJECT_DIR"

PROMPT='You have access to the macro-claw task API via environment variables.

To create a sub-task:
  curl -s -X POST "$MC2_API_URL/api/tasks" \
    -H "Authorization: Bearer $MC2_JOB_TOKEN" \
    -H "Content-Type: application/json" \
    -d '"'"'{"prompt": "your task description"}'"'"'

To check a task status:
  curl -s "$MC2_API_URL/api/tasks/<TASK_ID>" \
    -H "Authorization: Bearer $MC2_JOB_TOKEN"

To list all your sub-tasks:
  curl -s "$MC2_API_URL/api/tasks" \
    -H "Authorization: Bearer $MC2_JOB_TOKEN"

Your goal:
1. Spawn two sub-tasks. Task 1 prompt: "Write a short poem (4-8 lines) about the ocean." Task 2 prompt: "Write a short poem (4-8 lines) about a forest."
2. Poll their status every 10 seconds until both are done.
3. Read the result_text from each completed task.
4. Pick your favourite poem and explain why in two sentences.'

"$SCRIPT_DIR/submit.sh" "$PROJECT_DIR" "$PROMPT" --capabilities spawn_task

echo ""
echo "Monitor progress:  ./list.sh"
echo "Orchestrator logs: ./dev.sh logs"
