# mc2 Capability API — Worker Tool Reference

Include this content in `append_system_prompt` or `claude_md` when spawning tasks
that need to use the capability API.

---

## Environment

The orchestrator injects these environment variables into every worker container:

| Variable | Description |
|---|---|
| `MC2_API_URL` | Base URL of the orchestrator's API (e.g., `http://macro-claw-orchestrator:3001`) |
| `MC2_JOB_ID` | This task's unique job ID |
| `MC2_JOB_TOKEN` | Bearer token for authenticating API requests |

## Authentication

All `/api/tasks` endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer $MC2_JOB_TOKEN
```

## Endpoints

### Create a child task

**Requires capability: `spawn_task`**

```
POST $MC2_API_URL/api/tasks
```

**Request body (JSON):**

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The task description / instructions for the child |
| `project_dir` | string | no | Working directory for the child (must be within your `allowed_paths`). Defaults to parent's `project_dir` |
| `model` | string | no | Model override (e.g., `claude-sonnet-4-6`) |
| `max_turns` | number | no | Maximum agentic turns |
| `max_budget_usd` | number | no | Maximum cost in USD |
| `system_prompt` | string | no | Replace the child's entire system prompt |
| `append_system_prompt` | string | no | Append to the child's default system prompt |
| `capabilities` | string[] | no | Capabilities to grant the child (e.g., `["spawn_task"]`) |
| `allowed_paths` | string[] | no | Directories the child can access (must be a subset of your own `allowed_paths`). Inherited from parent if omitted |
| `priority` | number | no | Lower numbers run first. Default: 0 |

**Example:**

```bash
curl -s -X POST "$MC2_API_URL/api/tasks" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Write unit tests for the auth module in /workspace/project/tests/",
    "project_dir": "/tmp/my-project"
  }'
```

**Response (201):**

```json
{ "id": "abc123-...", "status": "pending" }
```

### Get a child task's status

```
GET $MC2_API_URL/api/tasks/{task_id}
```

Only returns tasks that are children of the calling task.

**Example:**

```bash
curl -s "$MC2_API_URL/api/tasks/abc123-..." \
  -H "Authorization: Bearer $MC2_JOB_TOKEN"
```

**Response (200):**

```json
{
  "id": "abc123-...",
  "status": "done",
  "result_text": "Tests written successfully...",
  "error": null,
  "cost_usd": 0.0234,
  "duration_ms": 15000,
  "created_at": "2026-03-15 01:00:00",
  "started_at": "2026-03-15 01:00:05",
  "finished_at": "2026-03-15 01:00:20"
}
```

**Status values:** `pending`, `running`, `done`, `failed`

### List all child tasks

```
GET $MC2_API_URL/api/tasks
```

Returns all tasks spawned by the calling task.

**Example:**

```bash
curl -s "$MC2_API_URL/api/tasks" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN"
```

**Response (200):**

```json
{
  "tasks": [
    { "id": "abc123-...", "status": "done", "result_text": "...", ... },
    { "id": "def456-...", "status": "running", "result_text": null, ... }
  ]
}
```

## Patterns

### Spawn two tasks and wait for both

```bash
# Spawn tasks
TASK_A=$(curl -s -X POST "$MC2_API_URL/api/tasks" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write the implementation", "project_dir": "/tmp/project"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

TASK_B=$(curl -s -X POST "$MC2_API_URL/api/tasks" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write the tests", "project_dir": "/tmp/project"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# Poll until both are done or failed
while true; do
  SA=$(curl -s "$MC2_API_URL/api/tasks/$TASK_A" \
    -H "Authorization: Bearer $MC2_JOB_TOKEN" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  SB=$(curl -s "$MC2_API_URL/api/tasks/$TASK_B" \
    -H "Authorization: Bearer $MC2_JOB_TOKEN" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")

  if [[ "$SA" == "done" || "$SA" == "failed" ]] && \
     [[ "$SB" == "done" || "$SB" == "failed" ]]; then
    break
  fi
  sleep 10
done
```

## Error Responses

| Status | Meaning |
|---|---|
| 400 | Bad request — missing or invalid fields |
| 401 | Unauthorized — invalid or missing Bearer token |
| 403 | Forbidden — missing required capability, or path not in `allowed_paths` |
| 404 | Task not found (or not a child of the caller) |
| 405 | Method not allowed |
