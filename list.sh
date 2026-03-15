#!/usr/bin/env bash
# Usage: ./list.sh [status]
set -euo pipefail

MC2_API="${MC2_API_URL:-http://localhost:3001}"
STATUS="${1:-}"

if [ -n "$STATUS" ]; then
  URL="$MC2_API/api/jobs?status=$STATUS"
else
  URL="$MC2_API/api/jobs"
fi

curl -s "$URL" | python3 -c "
import sys, json

data = json.load(sys.stdin)
jobs = data.get('jobs', [])

if not jobs:
    print('No jobs found.')
    sys.exit(0)

fmt = '{:<38} {:<8} {:<50} {:>8} {:>10} {:>12}'
print(fmt.format('id', 'status', 'prompt', 'cost', 'duration', 'created'))
print('-' * 130)
for j in jobs:
    prompt = (j.get('prompt') or '')[:48]
    cost = f\"\${j['cost_usd']:.4f}\" if j.get('cost_usd') else ''
    dur = f\"{j['duration_ms']}ms\" if j.get('duration_ms') else ''
    created = (j.get('created_at') or '')[:19]
    print(fmt.format(j['id'], j['status'], prompt, cost, dur, created))
"
