#!/usr/bin/env bash
# Fake Claude Code CLI for testing.
# Emits minimal stream-json events that the orchestrator can parse.
# Usage: fake-agent.sh [claude args...] <prompt>

# Emit stream-json events
cat <<'JSONL'
{"type":"system","subtype":"init","session_id":"test-session-001","model":"fake-model","tools":[],"mcp_servers":[]}
{"type":"assistant","message":{"id":"msg_test","type":"message","role":"assistant","content":[{"type":"text","text":"I received your prompt and I'm working on it."}],"model":"fake-model","stop_reason":"tool_use"}}
{"type":"assistant","message":{"id":"msg_test2","type":"message","role":"assistant","content":[{"type":"text","text":"Task complete. Here is the result."}],"model":"fake-model","stop_reason":"end_turn"}}
{"type":"result","result":"Task complete. Here is the result.","total_cost_usd":0.0042,"is_error":false,"session_id":"test-session-001"}
JSONL

# Optionally create a file in the workspace to prove we ran
if [ -d /workspace/project ]; then
  echo "fake-agent was here" > /workspace/project/agent-output.txt
fi

exit 0
