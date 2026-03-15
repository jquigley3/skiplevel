# Plan: Scoped Token Permissions

## Design Principles

1. **No secrets in containers.** Tokens never leave the proxy. Agents make requests through a proxy endpoint; the proxy injects credentials on the wire.
2. **Two permission operations:** (a) create a permission for someone else and give it to them, (b) request a permission for yourself. Delegation is itself a gated permission (`can_delegate`).
3. **Project-scoped defaults.** A project (`project_dir`) can have auto-granted tokens so every job in that project starts with access.
4. **Human-in-the-loop.** Agents can request permissions. Requests enter a queue. Humans approve/deny via CLI. The agent's tool has built-in wait/poll so it blocks until resolved.

---

## Concepts

### Token

A registered secret the proxy can inject into outbound requests. Stored in DB.

| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT PK | UUID |
| `name` | TEXT UNIQUE | Human-readable, e.g. `github-ro`, `jira-team-a` |
| `url_pattern` | TEXT | Regex matched against the full request URL |
| `inject_header` | TEXT | Header name to set, e.g. `Authorization` |
| `inject_value` | TEXT | Full header value, e.g. `Bearer ghp_abc123` (the actual secret) |
| `description` | TEXT | What this token is for (shown to agents in errors) |
| `project_dir` | TEXT NULL | If set, token is only visible to jobs in this project |
| `created_at` | TEXT | Timestamp |

Notes:
- `inject_header` + `inject_value` is the credential. Flexible enough for `Authorization: Bearer ...`, `X-Api-Key: ...`, `Authorization: Basic ...`, etc.
- `url_pattern` is a regex. `https://api\.github\.com/repos/myorg/.*` or `https://.*\.atlassian\.net/.*`.
- `project_dir` scopes visibility. A token with `project_dir = /Users/josh/myapp` can only be used by jobs whose `project_dir` starts with that path. If `NULL`, usable by any project.

### Permission

A grant connecting a job to a token.

| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT PK | UUID |
| `token_id` | TEXT FK | Which token |
| `job_id` | TEXT FK | Which job has access |
| `can_delegate` | INTEGER | 1 = job can delegate this permission to children |
| `granted_by` | TEXT | `'human'`, or a job ID (for delegated permissions) |
| `expires_at` | TEXT | When this permission expires |
| `created_at` | TEXT | Timestamp |

### Permission Request

An agent's request for access, pending human approval.

| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT PK | UUID |
| `token_name` | TEXT | Requested token name |
| `job_id` | TEXT FK | Job requesting access |
| `reason` | TEXT | Agent's explanation for why it needs this |
| `duration_minutes` | INTEGER | How long the agent wants access |
| `can_delegate` | INTEGER | Whether agent wants to delegate |
| `status` | TEXT | `pending`, `approved`, `denied` |
| `decided_at` | TEXT NULL | Timestamp of decision |
| `decided_reason` | TEXT NULL | Human's reason for deny |
| `created_at` | TEXT | Timestamp |

### Project Permission

Auto-granted tokens for a project directory. Every job in the project gets these.

| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT PK | UUID |
| `project_dir` | TEXT | Project directory prefix |
| `token_id` | TEXT FK | Token to auto-grant |
| `can_delegate` | INTEGER | Whether auto-granted perm allows delegation |
| `duration_minutes` | INTEGER | Duration for auto-granted permissions |

---

## Components

### 1. New file: `orchestrator/src/permissions.ts`

Core permission logic, separated from the DB and API layers.

```
Functions:
- createToken(input): string                    — register a new token
- getToken(id): Token | undefined
- getTokenByName(name): Token | undefined
- listTokens(projectDir?): Token[]             — list tokens, optionally filtered
- deleteToken(id): void

- grantPermission(input): string               — create a permission
- revokePermission(id): void
- getJobPermissions(jobId): Permission[]        — all active (non-expired) perms for a job
- hasPermission(jobId, tokenId): Permission | null
- delegatePermission(parentJobId, childJobId, tokenId, canDelegate, durationMin): string
  — validates parent has can_delegate=true and is not expired

- createPermissionRequest(input): string
- getPermissionRequest(id): PermissionRequest
- listPendingRequests(): PermissionRequest[]
- approveRequest(id, durationMinutes?): string  — creates permission, returns perm ID
- denyRequest(id, reason?): void

- getProjectPermissions(projectDir): ProjectPermission[]
- setProjectPermission(input): string
- removeProjectPermission(id): void
- autoGrantProjectPermissions(jobId, projectDir): void
  — called when a job is claimed; creates permissions from project defaults

- findMatchingToken(url, jobId): { token: Token, permission: Permission } | null
  — matches url against url_pattern, checks job has active permission
```

### 2. DB schema additions in `db.ts`

Add four new tables in `initDb()`: `tokens`, `permissions`, `permission_requests`, `project_permissions`. Use the same migration pattern (check column/table existence).

### 3. Proxy endpoint: `POST /api/proxy`

New handler in `tools.ts` (or a new file `proxy-handler.ts`).

**Auth:** Bearer token (same as `/api/tasks`).

**Request:**
```json
{
  "url": "https://api.github.com/repos/owner/repo/contents/README.md",
  "method": "GET",
  "headers": { "Accept": "application/json" },
  "body": null
}
```

**Flow:**
1. Authenticate job via Bearer token.
2. Call `findMatchingToken(url, jobId)`.
3. **If matched:** Make the outbound request, injecting `inject_header: inject_value`. Return `{ status: <http_status>, headers: {...}, body: "..." }`.
4. **If no matching token registered:** Return `403` with:
   ```json
   {
     "error": "no_token",
     "message": "No registered token matches this URL. Ask the project owner to register a token for this URL pattern.",
     "url": "https://api.github.com/..."
   }
   ```
5. **If token exists but job lacks permission:** Return `403` with:
   ```json
   {
     "error": "no_permission",
     "message": "Token 'github-ro' matches this URL but you don't have permission. Use POST /api/permissions/request to request access.",
     "token_name": "github-ro",
     "token_description": "Read-only GitHub access for myorg repos"
   }
   ```

### 4. Permission API endpoints

#### Worker endpoints (Bearer auth):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/permissions` | List my active permissions |
| `POST` | `/api/permissions/request` | Request a permission |
| `GET` | `/api/permissions/request/:id` | Check status of my request (for polling) |

**`POST /api/permissions/request`:**
```json
{
  "token_name": "github-ro",
  "reason": "Need to read repo contents for code review",
  "duration_minutes": 30,
  "can_delegate": false,
  "wait": true,
  "wait_timeout_seconds": 300
}
```

If `wait: true`: long-poll, returning when approved/denied or `wait_timeout_seconds` elapses.

**Response (approved):**
```json
{ "status": "approved", "permission_id": "...", "expires_at": "..." }
```

**Response (denied):**
```json
{ "status": "denied", "reason": "Not needed for this task" }
```

**Response (timeout):**
```json
{
  "status": "pending",
  "request_id": "...",
  "message": "Request is pending human approval. Poll GET /api/permissions/request/<id> or retry with wait."
}
```

#### Worker: delegate permission to child

When calling `POST /api/tasks`, include `permissions` array:
```json
{
  "prompt": "...",
  "permissions": [
    { "token_name": "github-ro", "can_delegate": false, "duration_minutes": 30 }
  ]
}
```

`handleCreateTask` validates:
- Parent has active permission for this token.
- Parent's permission has `can_delegate = true`.
- Child's `duration_minutes` does not exceed parent's remaining time.
- Child's `can_delegate` cannot be `true` if parent's is `false`.

#### Host endpoints (no auth):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tokens` | List registered tokens (secrets redacted) |
| `POST` | `/api/tokens` | Register a new token |
| `DELETE` | `/api/tokens/:id` | Remove a token |
| `GET` | `/api/permissions/requests` | List pending requests (`?status=pending`) |
| `POST` | `/api/permissions/requests/:id/approve` | Approve a request |
| `POST` | `/api/permissions/requests/:id/deny` | Deny a request |
| `GET` | `/api/project-permissions` | List project-level auto-grants |
| `POST` | `/api/project-permissions` | Add a project-level auto-grant |
| `DELETE` | `/api/project-permissions/:id` | Remove a project-level auto-grant |

#### Host: pre-grant permissions at job submission

`POST /api/jobs` body gains optional `permissions`:
```json
{
  "prompt": "...",
  "project_dir": "/Users/josh/myapp",
  "permissions": [
    { "token_name": "github-ro", "can_delegate": true, "duration_minutes": 60 }
  ]
}
```

These are granted immediately by the orchestrator (no approval needed; the human is submitting the job).

### 5. Orchestrator changes

In `dispatchJob()` (orchestrator.ts), after claiming a job:
- Call `autoGrantProjectPermissions(job.id, job.project_dir)` to apply project defaults.
- Process any `permissions` from the job submission (stored on the job row or a new column).

### 6. CLI scripts

#### `tokens.sh` — Token management

```bash
./tokens.sh add \
  --name github-ro \
  --url-pattern "https://api\.github\.com/repos/myorg/.*" \
  --header Authorization \
  --value "Bearer ghp_abc123" \
  --description "Read-only GitHub access for myorg" \
  --project /Users/josh/myapp    # optional: scope to project

./tokens.sh list                  # list tokens (secrets redacted)
./tokens.sh remove <id-or-name>
```

#### `permissions.sh` — Approval queue

```bash
./permissions.sh pending                           # list pending requests
./permissions.sh approve <request-id>              # approve with requested duration
./permissions.sh approve <request-id> --duration 60  # override duration
./permissions.sh deny <request-id> --reason "..."

./permissions.sh project-add \
  --project /Users/josh/myapp \
  --token github-ro \
  --can-delegate \
  --duration 60

./permissions.sh project-list
./permissions.sh project-remove <id>
```

#### `submit.sh` changes

Add `--permission` flag (repeatable):
```bash
./submit.sh /path/to/project "Do the thing" \
  --permission "github-ro:delegate:60" \
  --permission "jira-read::30"
```

Format: `token_name:delegate_flag:duration_minutes`. Parsed and sent as `permissions` array.

### 7. Agent documentation: `developer/permissions.md`

Referenced from CLAUDE.md / append_system_prompt. Tells agents:

1. **What permissions are.** Your job may have permissions to access external services (GitHub, Jira, etc.) through authenticated HTTP requests. Requests go through a proxy that injects credentials; you never see the actual tokens.

2. **Making authenticated requests.** Use `POST $MC2_API_URL/api/proxy` with your job Bearer token:
   ```bash
   curl -s -X POST "$MC2_API_URL/api/proxy" \
     -H "Authorization: Bearer $MC2_JOB_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://api.github.com/repos/myorg/myrepo/contents","method":"GET"}'
   ```

3. **Checking your permissions.** `GET $MC2_API_URL/api/permissions` returns your active permissions.

4. **Requesting a permission.** If a proxy request returns `no_permission`, request access:
   ```bash
   curl -s -X POST "$MC2_API_URL/api/permissions/request" \
     -H "Authorization: Bearer $MC2_JOB_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"token_name":"github-ro","reason":"Need to read repo for code review","duration_minutes":30,"wait":true}'
   ```
   With `wait: true`, the call blocks until approved/denied. If approval takes too long, return to the user explaining what permission is needed.

5. **Delegating to child tasks.** When spawning children via `POST /api/tasks`, include permissions you want to share:
   ```json
   { "prompt": "...", "permissions": [{"token_name":"github-ro","can_delegate":false}] }
   ```
   You can only delegate permissions you hold with `can_delegate: true`.

6. **What to do when denied.** If a permission request is denied or times out, do not retry. Return a result explaining what was needed and why, so the user can grant access and resubmit.

### 8. CLAUDE.md / AGENTS.md reference

Add a note in the project's CLAUDE.md pointing agents to `developer/permissions.md` when they need authenticated external access. Include a one-liner summary so the agent knows the system exists without reading the full doc on every run.

---

## Implementation Order

Each phase is a commit-sized unit. Later phases depend on earlier ones.

### Phase 1: Schema + Token Registry
**Files:** `db.ts`, `permissions.ts` (new), `tokens.sh` (new)

1. Add `tokens` table to `initDb()`.
2. Create `permissions.ts` with token CRUD functions.
3. Add `/api/tokens` endpoints in `tools.ts`.
4. Create `tokens.sh` CLI.
5. Tests: token create, list, delete, project scoping.

### Phase 2: Permission Grants + Delegation
**Files:** `db.ts`, `permissions.ts`, `tools.ts`

1. Add `permissions`, `project_permissions` tables.
2. Implement `grantPermission`, `revokePermission`, `hasPermission`, `delegatePermission`.
3. Implement `autoGrantProjectPermissions`, project permission CRUD.
4. Update `handleCreateTask` to accept and validate `permissions` array.
5. Update `handleSubmitJob` to accept `permissions` array.
6. Update `dispatchJob` in orchestrator.ts to auto-grant project permissions.
7. Add `/api/permissions` (list my perms) worker endpoint.
8. Add `/api/project-permissions` host endpoints.
9. `permissions.sh` for project permission management.
10. Tests: grant, delegate, expiry, project auto-grant.

### Phase 3: Permission Requests + Human Approval
**Files:** `db.ts`, `permissions.ts`, `tools.ts`, `permissions.sh`

1. Add `permission_requests` table.
2. Implement `createPermissionRequest`, `approveRequest`, `denyRequest`, `listPendingRequests`.
3. Add `POST /api/permissions/request` with wait/poll support.
4. Add `GET /api/permissions/request/:id` for polling.
5. Add host endpoints: `GET /api/permissions/requests`, `POST .../approve`, `POST .../deny`.
6. Add `permissions.sh pending/approve/deny` commands.
7. Tests: request lifecycle, wait timeout, approve creates permission.

### Phase 4: Proxy Endpoint
**Files:** `credential-proxy.ts` or new `proxy-handler.ts`, `tools.ts`

1. Implement `POST /api/proxy` handler.
2. URL matching against `url_pattern`.
3. Permission check via `findMatchingToken`.
4. Outbound request with credential injection.
5. Error responses with guidance for agents.
6. Tests: proxy with permission, proxy without permission, no matching token.

### Phase 5: CLI + submit.sh + Agent Documentation
**Files:** `submit.sh`, `developer/permissions.md` (new), `CLAUDE.md`

1. Add `--permission` flag to `submit.sh`.
2. Write `developer/permissions.md` agent documentation.
3. Reference from CLAUDE.md.
4. End-to-end test: submit job with permission, job uses proxy.

---

## Future Work (TODOs)

- **Secure token storage.** Replace DB plaintext with encrypted-at-rest or OS keychain integration.
- **HTTP_PROXY transparent mode.** Set `HTTP_PROXY`/`HTTPS_PROXY` in containers so CLI tools (`git`, `gh`, `curl`) route through the proxy automatically. Requires CONNECT tunneling + TLS MITM with a CA cert mounted in the container.
- **Permission audit log.** Record every proxy request (who, what URL, when, approved/denied) for compliance.
- **Token rotation.** Support updating a token's secret without breaking active permissions.
- **Rate limiting per token.** Prevent a single job from exhausting a rate-limited external API.
- **Network isolation enforcement.** Block direct outbound from containers via Docker network policy, so the proxy is the only path. Currently relying on "agents with good intent."
- **Notification for pending requests.** Push notifications (webhook, desktop notification) when a permission request is waiting.
- **Web dashboard.** Visual approval queue alongside job monitoring.
