# Scoped Permissions for External API Access

Your job may have permissions to access external services (GitHub, Jira, etc.) through authenticated HTTP requests. Requests go through a proxy that injects credentials; you never see the actual tokens.

## Making authenticated requests

Use `POST $MC2_API_URL/api/proxy` with your job Bearer token:

```bash
curl -s -X POST "$MC2_API_URL/api/proxy" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://api.github.com/repos/myorg/myrepo/contents","method":"GET"}'
```

Request body:
- `url` (required): Full URL to request
- `method` (optional): HTTP method, default `GET`
- `headers` (optional): Object of headers to send
- `body` (optional): Request body for POST/PUT

Response: `{ status, headers, body }` — the HTTP status, response headers, and body from the upstream server.

## Checking your permissions

`GET $MC2_API_URL/api/permissions` returns your active permissions:

```bash
curl -s "$MC2_API_URL/api/permissions" -H "Authorization: Bearer $MC2_JOB_TOKEN"
```

## Requesting a permission

If a proxy request returns `no_permission`, request access:

```bash
curl -s -X POST "$MC2_API_URL/api/permissions/request" \
  -H "Authorization: Bearer $MC2_JOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"token_name":"github-ro","reason":"Need to read repo for code review","duration_minutes":30,"wait":true}'
```

With `wait: true`, the call blocks until approved or denied. If approval takes too long, return to the user explaining what permission is needed.

## Delegating to child tasks

When spawning children via `POST /api/tasks`, include permissions you want to share:

```json
{ "prompt": "...", "permissions": [{"token_name":"github-ro","can_delegate":false}] }
```

You can only delegate permissions you hold with `can_delegate: true`.

## When denied or timeout

If a permission request is denied or times out, do not retry. Return a result explaining what was needed and why, so the user can grant access and resubmit.
