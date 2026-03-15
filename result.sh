#!/usr/bin/env bash
# Usage: ./result.sh <job-id>
set -euo pipefail

MC2_API="${MC2_API_URL:-http://localhost:3001}"
JOB_ID="${1:?Usage: ./result.sh <job-id>}"

curl -s "$MC2_API/api/jobs/$JOB_ID" | python3 -m json.tool
