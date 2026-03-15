#!/usr/bin/env bash
# fake-agent.sh — simulates a Claude CLI sub-agent for credential-free testing.
# Accepts and ignores all arguments.

set -euo pipefail

# Create ipc/ directory if it doesn't exist
mkdir -p ipc

# Read first line of ipc/task.md if it exists
if [[ -f ipc/task.md ]]; then
  task_line=$(head -n 1 ipc/task.md)
else
  task_line="unknown"
fi

# Simulate a short task
sleep 0.5

# Write canned result
cat > ipc/result.md <<EOF
# Result
Fake agent completed successfully.
Task description was: ${task_line}
EOF

# Print one line of stream-json so the orchestrator's stream parser doesn't error
echo '{"type":"result","subtype":"success","result":"Fake agent done.","session_id":"fake-000","is_error":false}'

exit 0
