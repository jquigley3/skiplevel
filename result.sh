#!/usr/bin/env bash
# Usage: ./result.sh <job-id> [--transcript]
set -euo pipefail

DB="${DB_PATH:-./orchestrator/data/macro-claw.db}"
JOB_ID="${1:?Usage: ./result.sh <job-id>}"
SHOW_TRANSCRIPT="${2:-}"

if [ "$SHOW_TRANSCRIPT" = "--transcript" ]; then
  sqlite3 -json "$DB" "SELECT id, status, result_text, transcript, cost_usd, duration_ms, error, worktree_path FROM jobs WHERE id = '$JOB_ID';"
else
  sqlite3 -json "$DB" "SELECT id, status, result_text, cost_usd, duration_ms, error, worktree_path FROM jobs WHERE id = '$JOB_ID';"
fi
