#!/usr/bin/env bash
# Usage: ./submit.sh <project-dir> <prompt> [--model <model>] [--priority <n>]
set -euo pipefail

DB="${DB_PATH:-./orchestrator/data/macro-claw.db}"
PROJECT_DIR="${1:?Usage: ./submit.sh <project-dir> <prompt>}"
PROMPT="${2:?Usage: ./submit.sh <project-dir> <prompt>}"
MODEL="${3:-}"
PRIORITY="${4:-0}"

JOB_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

# Escape single quotes in prompt for SQLite
SAFE_PROMPT="${PROMPT//\'/\'\'}"
MODEL_VAL=$([ -n "$MODEL" ] && echo "'$MODEL'" || echo "NULL")

sqlite3 "$DB" "INSERT INTO jobs (id, prompt, project_dir, model, priority)
  VALUES ('$JOB_ID', '$SAFE_PROMPT', '$PROJECT_DIR', $MODEL_VAL, $PRIORITY);"

echo "Job submitted: $JOB_ID"
echo "Check status:  ./result.sh $JOB_ID"
