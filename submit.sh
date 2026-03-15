#!/usr/bin/env bash
# Usage: ./submit.sh <project-dir> <prompt> [--model <m>] [--priority <n>] [--capabilities <c1,c2>] [--allowed-paths <p1,p2>]
set -euo pipefail

MC2_API="${MC2_API_URL:-http://localhost:3001}"

PROJECT_DIR="${1:?Usage: ./submit.sh <project-dir> <prompt> [flags]}"
PROMPT="${2:?Usage: ./submit.sh <project-dir> <prompt> [flags]}"
shift 2

MODEL=""
PRIORITY="0"
CAPABILITIES=""
ALLOWED_PATHS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)         MODEL="$2"; shift 2 ;;
    --priority)      PRIORITY="$2"; shift 2 ;;
    --capabilities)  CAPABILITIES="$2"; shift 2 ;;
    --allowed-paths) ALLOWED_PATHS="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Build JSON payload via Python (handles arbitrary prompt content safely)
PAYLOAD=$(python3 -c "
import json, sys

body = {
    'prompt': sys.argv[1],
    'project_dir': sys.argv[2],
    'priority': int(sys.argv[3]),
}

model = sys.argv[4]
caps = sys.argv[5]
paths = sys.argv[6]

if model:
    body['model'] = model
if caps:
    body['capabilities'] = caps.split(',')
if paths:
    body['allowed_paths'] = paths.split(',')

print(json.dumps(body))
" "$PROMPT" "$PROJECT_DIR" "$PRIORITY" "$MODEL" "$CAPABILITIES" "$ALLOWED_PATHS")

RESPONSE=$(curl -s -X POST "$MC2_API/api/jobs" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

JOB_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

if [ -n "$JOB_ID" ]; then
  echo "Job submitted: $JOB_ID"
  echo "Check status:  ./result.sh $JOB_ID"
else
  echo "Error: $RESPONSE" >&2
  exit 1
fi
