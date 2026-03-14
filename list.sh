#!/usr/bin/env bash
# Usage: ./list.sh [status]
DB="${DB_PATH:-./data/macro-claw.db}"
STATUS="${1:-}"

if [ -n "$STATUS" ]; then
  sqlite3 -column -header "$DB" "SELECT id, status, substr(prompt,1,60) as prompt, priority, cost_usd, duration_ms FROM jobs WHERE status = '$STATUS' ORDER BY created_at DESC LIMIT 20;"
else
  sqlite3 -column -header "$DB" "SELECT id, status, substr(prompt,1,60) as prompt, priority, cost_usd, duration_ms FROM jobs ORDER BY created_at DESC LIMIT 20;"
fi
