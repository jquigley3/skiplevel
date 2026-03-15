# Scoped Permissions — Agent Reference

> **Audience:** This document is for agents running inside macro-claw worker containers. If you are the user's interactive session (reading CLAUDE.md on the host), do not follow these instructions — see CLAUDE.md for your role.

You are running inside a worker container. All your outbound HTTP requests to external services (GitHub, Jira, etc.) must go through the credential proxy. The proxy injects authentication tokens on your behalf. You never see or handle the actual secrets.

## Environment Variables

These are available inside your worker container:

- `MC2_API_URL` — Base URL for all API calls (e.g. `http://proxy:3001`)
- `MC2_JOB_TOKEN` — Your Bearer token for authentication

Every API call below uses these. If they are not set, your container was not started correctly.

---

## Step 1: Check Your Current Permissions

Before making external API requests, check what permissions you already have.

**Request:**

```bash
curl -s "$MC2_API_URL/api/permissions" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN"
```

**Response (200):**

```json
{
  "permissions": [
    {
      "id": "abc-123",
      "token_name": "github-ro",
      "can_delegate": true,
      "expires_at": "2025-01-15T12:30:00.000Z"
    }
  ]
}
```

Each permission entry tells you:
- `token_name` — the name of the token you can use (e.g. `github-ro`, `jira-read`)
- `can_delegate` — whether you can pass this permission to child tasks
- `expires_at` — when the permission expires (UTC ISO 8601)

If the `permissions` array is empty, you have no permissions yet. You will need to request them (see Step 3).

---

## Step 2: Make Requests Through the Proxy

To call an external API, send a POST to the proxy endpoint. The proxy finds a token whose `url_pattern` matches your target URL, checks you have permission for it, and injects the credential into the outbound request.

**Request:**

```bash
curl -s -X POST "$MC2_API_URL/api/proxy" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.github.com/repos/myorg/myrepo/pulls",
    "method": "GET"
  }'
```

**Request body fields:**

| Field     | Required | Type   | Description                              |
|-----------|----------|--------|------------------------------------------|
| `url`     | yes      | string | Full URL to request                      |
| `method`  | no       | string | HTTP method (default: `GET`)             |
| `headers` | no       | object | Additional headers to send               |
| `body`    | no       | string | Request body (for POST, PUT, PATCH)      |

**Success response (200):**

```json
{
  "status": 200,
  "headers": { "content-type": "application/json; charset=utf-8" },
  "body": "[{\"id\":1,\"title\":\"My PR\"}]"
}
```

The `status`, `headers`, and `body` are from the upstream server. The `body` is always a string — parse it with `json.loads()` or `JSON.parse()` if needed.

### Proxy Error Responses

The proxy returns three types of errors. You must handle each differently.

#### Error: `no_permission` (403)

A token exists that matches this URL, but you don't have permission to use it.

```json
{
  "error": "no_permission",
  "message": "Token 'github-ro' matches this URL but you don't have permission.",
  "token_name": "github-ro",
  "token_description": "Read-only GitHub access"
}
```

**What to do:** Use the `token_name` from this response to request permission (see Step 3 below).

#### Error: `no_token` (403)

No registered token matches this URL at all.

```json
{
  "error": "no_token",
  "message": "No registered token matches this URL.",
  "url": "https://api.example.com/data"
}
```

**What to do:** You cannot fix this. Report in your result that you needed access to this URL and no token is registered for it. The project owner must register a token using `tokens.sh`.

#### Error: `502` (proxy failure)

The proxy found a token and made the request, but the upstream server returned an error or was unreachable.

```json
{
  "error": "Proxy request failed",
  "message": "fetch failed"
}
```

**What to do:** This is a network or upstream issue. Retry once. If it persists, report the error.

---

## Step 3: Request a Permission

If the proxy returned `no_permission`, request access. A human will approve or deny.

**Request (with wait):**

```bash
curl -s -X POST "$MC2_API_URL/api/permissions/request" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "token_name": "github-ro",
    "reason": "Need to read repository files for code review task",
    "duration_minutes": 30,
    "wait": true
  }'
```

**Request body fields:**

| Field              | Required | Type    | Default | Description                                    |
|--------------------|----------|---------|---------|------------------------------------------------|
| `token_name`       | yes      | string  | —       | Exact token name (from the `no_permission` error) |
| `reason`           | no       | string  | —       | Why you need access (shown to the human approver) |
| `duration_minutes` | no       | number  | 30      | How long you need access                       |
| `can_delegate`     | no       | boolean | false   | Whether you need to pass this to child tasks   |
| `wait`             | no       | boolean | false   | Block until the human decides                  |
| `wait_timeout_seconds` | no   | number  | 300     | Max seconds to wait (capped at 600)            |

### Behavior with `wait: true`

The request blocks (long-polls) until the human approves or denies, or until the timeout.

**If approved (200):**

```json
{
  "status": "approved",
  "permission_id": "perm-456",
  "expires_at": "2025-01-15T13:00:00.000Z"
}
```

You now have permission. Retry your proxy request.

**If denied (200):**

```json
{
  "status": "denied",
  "reason": "Not needed for this task"
}
```

Do NOT retry. Return a result explaining what permission was denied and why your task could not complete.

**If timed out (200):**

```json
{
  "status": "pending",
  "request_id": "req-789",
  "message": "Request is pending human approval."
}
```

The human hasn't responded yet. Return a result explaining that your task is blocked waiting for permission approval.

### Behavior with `wait: false` (or omitted)

The request returns immediately with `status: "pending"`. You must poll to check the result.

**Initial response (201):**

```json
{
  "status": "pending",
  "request_id": "req-789",
  "message": "Request is pending human approval. Poll GET /api/permissions/request/<id>."
}
```

**Poll the status:**

```bash
curl -s "$MC2_API_URL/api/permissions/request/req-789" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN"
```

Returns the same `approved`, `denied`, or `pending` responses as above.

### Recommended approach

Use `"wait": true` with a reasonable timeout. This is the simplest flow:

1. Send the permission request with `wait: true`
2. If approved, retry the proxy call
3. If denied or timed out, stop and report what was needed

---

## Step 4: Delegate Permissions to Child Tasks

When you spawn a child task via `POST /api/tasks`, you can pass along your permissions so the child doesn't have to request them separately.

**Request:**

```bash
curl -s -X POST "$MC2_API_URL/api/tasks" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Review the latest PR on myorg/myrepo",
    "permissions": [
      {
        "token_name": "github-ro",
        "can_delegate": false,
        "duration_minutes": 30
      }
    ]
  }'
```

**Rules for delegation:**

1. You can only delegate tokens you currently have permission for
2. You can only delegate if your permission has `can_delegate: true`
3. The child's permission duration is capped at the remaining time on your permission
4. If you set `can_delegate: false` on the child, the child cannot pass it further

If you try to delegate a token you don't have or can't delegate, the task creation fails with a 403 error.

**Example error (403):**

```json
{ "error": "Parent cannot delegate token: github-ro" }
```

---

## Complete Workflow Example

Here is a complete example of an agent that needs to read a GitHub repository:

```bash
# 1. Check existing permissions
PERMS=$(curl -s "$MC2_API_URL/api/permissions" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN")
echo "$PERMS"
# Response: {"permissions":[]}  — no permissions yet

# 2. Try the proxy anyway (it will tell us what token to request)
RESULT=$(curl -s -X POST "$MC2_API_URL/api/proxy" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://api.github.com/repos/myorg/myrepo/contents","method":"GET"}')
echo "$RESULT"
# Response: {"error":"no_permission","token_name":"github-ro",...}

# 3. Request permission using the token_name from the error
APPROVAL=$(curl -s -X POST "$MC2_API_URL/api/permissions/request" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "token_name": "github-ro",
    "reason": "Need to read repo contents for code review",
    "duration_minutes": 30,
    "wait": true
  }')
echo "$APPROVAL"
# Response: {"status":"approved","permission_id":"perm-123","expires_at":"..."}

# 4. Retry the proxy request — it now works
RESULT=$(curl -s -X POST "$MC2_API_URL/api/proxy" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://api.github.com/repos/myorg/myrepo/contents","method":"GET"}')
echo "$RESULT"
# Response: {"status":200,"headers":{...},"body":"[...]"}
```

---

## Decision Tree

Use this when you need to access an external API:

```
Need to call an external URL?
│
├─ Call POST /api/proxy with the URL
│   │
│   ├─ 200 → Success. Parse the response body.
│   │
│   ├─ 403 "no_permission"
│   │   └─ Read token_name from error
│   │   └─ POST /api/permissions/request with that token_name and wait:true
│   │       ├─ approved → Retry POST /api/proxy
│   │       ├─ denied → Stop. Report what was needed in your result.
│   │       └─ timed out → Stop. Report that approval is pending.
│   │
│   ├─ 403 "no_token"
│   │   └─ Stop. Report that no token is registered for this URL.
│   │
│   └─ 502 → Upstream error. Retry once, then report failure.
│
└─ Spawning a child task that needs API access?
    └─ Include permissions array in POST /api/tasks
    └─ Only tokens where you have can_delegate: true
```

---

## For Project Owners: Setting Up Tokens and Permissions

This section is for humans managing the orchestrator, not for agents.

### Register a token

```bash
./tokens.sh add \
  --name github-ro \
  --url-pattern "https://api\\.github\\.com/repos/myorg/.*" \
  --header Authorization \
  --value "Bearer ghp_xxxxxxxxxxxx" \
  --description "Read-only GitHub access for myorg" \
  --project /path/to/project
```

- `--name` — unique identifier for this token (agents reference this name)
- `--url-pattern` — regex matching URLs this token applies to
- `--header` — HTTP header to inject (usually `Authorization`)
- `--value` — the actual secret value (e.g. `Bearer ghp_...`, `Basic ...`)
- `--description` — shown to agents so they know what the token is for
- `--project` — optional; scope token visibility to a project directory

### List and remove tokens

```bash
./tokens.sh list
./tokens.sh list --project /path/to/project
./tokens.sh remove github-ro
```

### Set up project-level auto-grants

Auto-grant permissions to every job in a project directory, so agents don't have to request them each time:

```bash
./permissions.sh project-add \
  --project /path/to/project \
  --token github-ro \
  --can-delegate \
  --duration 60
```

### Manage the approval queue

```bash
./permissions.sh pending                              # list pending requests
./permissions.sh approve <request-id>                 # approve with default duration
./permissions.sh approve <request-id> --duration 15   # approve for 15 minutes
./permissions.sh deny <request-id> --reason "Not needed"
```

### Pre-grant permissions when submitting a job

```bash
./submit.sh /path/to/project "Do the thing" \
  --permission "github-ro:delegate:60" \
  --permission "jira-read::30"
```

Format: `token_name:delegate_flag:duration_minutes`
- `delegate` means the agent can pass this permission to child tasks
- Leave delegate empty (just `::`) to deny delegation
- Duration is in minutes (default 60 if omitted)
