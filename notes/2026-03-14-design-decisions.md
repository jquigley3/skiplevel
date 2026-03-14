# Design Decisions

## Auth Flow (Interactive)

Desired flow: Claude CLI detects existing OAuth key from mounted `~/.claude` config and prompts with a simple yes/no to reuse it. No manual token extraction or injection needed. Let the CLI handle auth natively.

For sub-agents (automated, no user interaction), a separate solution is needed — pre-configured API key or token passthrough.

## NanoClaw Integration Scope

Reuse NanoClaw's container-based sandbox model (Docker now, Apple Container later) but NOT the messaging-channel architecture. The harness is not about routing commands from WhatsApp/Telegram into containers — it's about orchestrating multiple Claude Code CLI instances as an engineering organization.

Take: container launch, mount patterns, security model.
Skip: channel registry, message routing, IPC watcher, credential proxy.

## Mutations via Tools (not Git)

All mutations (file writes, code changes, shell commands) happen through Claude's tool calls. This means:

- **Permissions on mutations = permissions on tools.** Grant a session a tool set; that defines its blast radius. Read-only sessions get no write tools. Scoped sessions get write tools constrained to a specific path.
- Git worktrees are not needed for isolation — tool grants replace them.
- If human-reviewable diffs or undo are needed, that is a separate concern from the session primitive.

## Session Response Collection via stream-json JSONL

Sessions are invoked with `--output-format stream-json`. The claude CLI emits one JSON event per stdout line:

```
{"type":"system","subtype":"init","session_id":"..."}
{"type":"assistant","message":{"content":[{"type":"text",...},{"type":"tool_use",...}]}}
{"type":"result","result":"<final text>","total_cost_usd":...,"session_id":"..."}
```

This structure exists "for free" — no sentinel markers or custom output protocol needed. After a session exits, the orchestrator writes:

- `ipc/transcript.jsonl` — full JSONL stream (all events)
- `ipc/session-result.json` — summary: `{sessionId, result, totalCostUsd, durationMs, exitCode}`

A receiving agent reads only what it needs:
- `session-result.json` for the final answer
- `transcript.jsonl` filtered by `type:"tool_use"` to see what mutations happened
- Full `transcript.jsonl` for detailed context
