#!/usr/bin/env bash
# Usage: ./submit.sh <project-dir> <prompt> [--model <m>] [--priority <n>] [--capabilities <c1,c2>]
set -euo pipefail

DB="${DB_PATH:-./orchestrator/data/macro-claw.db}"

PROJECT_DIR="${1:?Usage: ./submit.sh <project-dir> <prompt> [--model m] [--priority n] [--capabilities c1,c2]}"
PROMPT="${2:?Usage: ./submit.sh <project-dir> <prompt> [--model m] [--priority n] [--capabilities c1,c2]}"
shift 2

MODEL=""
PRIORITY="0"
CAPABILITIES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)      MODEL="$2"; shift 2 ;;
    --priority)   PRIORITY="$2"; shift 2 ;;
    --capabilities) CAPABILITIES="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

python3 -c "
import sqlite3, uuid, json, sys, os

db_path = sys.argv[1]
project_dir = sys.argv[2]
prompt = sys.argv[3]
model = sys.argv[4] or None
priority = int(sys.argv[5])
caps_csv = sys.argv[6]

job_id = str(uuid.uuid4())
capabilities = json.dumps(caps_csv.split(',')) if caps_csv else None

conn = sqlite3.connect(db_path)
conn.execute(
    '''INSERT INTO jobs (id, prompt, project_dir, model, priority, capabilities)
       VALUES (?, ?, ?, ?, ?, ?)''',
    (job_id, prompt, project_dir, model, priority, capabilities),
)
conn.commit()
conn.close()

print(f'Job submitted: {job_id}')
print(f'Check status:  ./result.sh {job_id}')
" "$DB" "$PROJECT_DIR" "$PROMPT" "$MODEL" "$PRIORITY" "$CAPABILITIES"
