# Macro-claw Logs Report

**Date:** 2026-03-15  
**Context:** Ran a smoketest job with Haiku (`claude-haiku-4-5`) to assess available logs and observability.

---

## Executive Summary

Logs are spread across three channels: **API response**, **orchestrator stdout**, and **database**. The API exposes a useful subset but omits several fields that exist in the DB. Failed jobs lose important diagnostic info because errors are taken from stderr only, while some failures (e.g. model errors) appear on stdout.

---

## 1. API Response (`GET /api/jobs/:id` / `./result.sh`)

**Source:** `tools.ts` → `jobDetail()`

### Fields Exposed

| Field | Type | Example | Notes |
|-------|------|---------|-------|
| `id` | string | `c9f76c38-28b8-43d2-88e3-eff1ef2ccf73` | Job UUID |
| `status` | string | `done`, `failed`, `pending`, `running` | |
| `prompt` | string | Full prompt text | |
| `project_dir` | string | Absolute path | |
| `model` | string \| null | `claude-haiku-4-5` | |
| `tools` | string[] \| null | `["spawn_task"]` or null | mc2_tools |
| `allowed_paths` | string[] \| null | | |
| `parent_job_id` | string \| null | | For child tasks |
| `result_text` | string \| null | Final assistant output | **Primary success output** |
| `error` | string \| null | `Exit code 1: <detail>` | stderr or resultText when stderr empty |
| `cost_usd` | number \| null | `0.0386397` | |
| `duration_ms` | number \| null | `10929` | |
| `exit_code` | number \| null | `0` or `1` | Process exit code |
| `worker_container` | string \| null | `macro-claw-c9f76c38-df38367d` | For `docker logs` |
| `retry_count` | number | `0` | Number of retries |
| `retry_after` | string \| null | ISO datetime | When job becomes claimable |
| `created_at` | string | `2026-03-15 10:29:45` | |
| `started_at` | string \| null | ISO timestamp | |
| `finished_at` | string \| null | ISO timestamp | |
| `transcript` | string \| null | stream-json lines | **Only when `?include=transcript`** |

### Optional: transcript

`GET /api/jobs/:id?include=transcript` returns the full stream-json transcript when present. Omit for default (smaller response).

### Fields in DB but NOT Exposed via API

| Field | Stored in DB | Use Case |
|-------|--------------|----------|
| `worktree_path` | ✅ | Path to worktree (if git) |
| `worktree_branch` | ✅ | Git branch used |

---

## 2. Orchestrator Logs (stdout/stderr)

**Source:** Pino logger + worker stdout/stderr forwarded to orchestrator process

### Log Events (Pino)

| Event | Level | When | Example |
|-------|-------|------|---------|
| Job submitted | INFO | `handleSubmitJob` | `{ jobId }` |
| Dispatching job | INFO | Start of `dispatchJob` | `{ jobId, project, priority }` |
| Not a git repo | WARN | `createWorktree` when not git | `{ projectDir, jobId }` |
| Spawning worker | INFO | Before `runWorker` | `{ jobId, containerName, model }` |
| Job completed | INFO | Success | `{ jobId, durationMs, costUsd }` |
| Job failed | ERROR | Failure | `{ jobId, error, durationMs }` |
| Retryable error | WARN | Requeue | `{ jobId, retryCount, delayMs, source }` |
| Poll error | ERROR | `claimNextJob` throws | `{ err }` |

### Worker Output (stdout)

Worker stdout is streamed to orchestrator stdout with `[jobId]` prefix:

```
[c9f76c38] I'll run a quick smoketest...
[c9f76c38] [tool:Bash] {"command":"ls -la /workspace/project",...}
[c9f76c38] [tool:Read] {"file_path":"/workspace/project/README.md",...}
[c9f76c38] ✅ **Smoketest passed!**
[c9f76c38] [done] cost=$0.0386 error=false
```

- **Assistant text** — Each line of assistant output
- **Tool invocations** — `[tool:Name]` with truncated JSON
- **Result summary** — `[done] cost=$X.XXXX error=true|false`

### Worker stderr

Forwarded with `[jobId]` prefix. Only the **last 500 chars** are stored in `job.error` when the job fails.

---

## 3. Failure Case: Error Information (Fixed)

**Previously:** Job failed with invalid model — API `error` was `"Exit code 1: "` (empty) because the model error appeared on stdout, not stderr.

**Fix:** When stderr is empty, the worker now uses `resultText` from the stream-json `result` event (which captures errors emitted on stdout). The `error` field will now contain the actual message when available.

---

## 4. Log Access by Scenario

| Scenario | Where to look | Gaps |
|----------|----------------|------|
| **Job succeeded** | `result.sh` → `result_text`, `cost_usd`, `duration_ms` | No transcript, no tool-by-tool trace |
| **Job failed** | `result.sh` → `error`; `docker logs` for orchestrator | `error` can be empty; no transcript |
| **Debug a specific run** | `docker logs` for orchestrator (worker stdout) | No structured way to get transcript; must grep logs |
| **Retry/rate-limit** | Orchestrator logs (WARN) | `retry_count` / `retry_after` not in API |
| **Container issues** | `worker_container` in DB | Not exposed via API — can't easily run `docker logs <container>` |

---

## 5. Recommendations

### Implemented (2026-03-15)

1. **Expose `transcript` via API** — `GET /api/jobs/:id?include=transcript` returns `transcript` when present.
2. **Improve `error` for failures** — When stderr is empty, use `resultText` from stream-json (captures model errors etc. that appear on stdout).
3. **Expose `exit_code` and `worker_container`** — Both included in job detail and task summary.
4. **Expose `retry_count` and `retry_after`** — Both included in job detail and task summary.

### Not yet implemented

5. **Structured worker logs** — Emit tool use, assistant text, and result as structured log events (e.g. JSON) for easier parsing.
6. **`worktree_path` / `worktree_branch`** — Mainly for git workflow debugging.
7. **Streaming job output** — WebSocket or SSE for live assistant output during execution.

---

## 6. Test Run Summary

| Job | Model | Status | Duration | Cost | Notes |
|-----|-------|--------|----------|------|-------|
| `b1e79fad` | claude-3-5-haiku-20241022 | failed | 2.2s | — | Invalid model; error on stdout, `error` field empty |
| `c9f76c38` | claude-haiku-4-5 | done | 10.9s | $0.039 | Smoketest passed; full output in `result_text` |
