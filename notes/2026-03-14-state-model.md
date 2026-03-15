# Design Rationale: Project State Model

**Date:** 2026-03-14
**Task:** HARNESS-001

## Overview

This document explains the schema choices for the harness project state model:
`project.yaml`, `tasks/<id>.yaml`, and `resources.yaml`.

---

## 1. `project.yaml` — Project Metadata

**Why YAML?**
YAML is human-readable, widely supported, and editable with a text editor.
It stays legible when `cat`-ed in a terminal, which matters for a tool that
agents and users both inspect directly.

**Why a separate file from `README.md`?**
`README.md` is prose for humans. `project.yaml` is machine-readable metadata
for the harness scheduler and CLI tools. Mixing them would make both harder to
parse. The pattern mirrors how many CI systems separate `.github/workflows/`
from documentation.

**Field choices:**

- `status` as an enum (`planning | active | paused | done`) gives the scheduler
  a clear signal: only `active` projects consume resources.
- `priority` as `P0`–`P3` matches common engineering conventions (P0 = fire,
  P3 = nice-to-have). Numeric sorts correctly.
- `scope_estimate` is a free-form string intentionally — scope language varies
  ("3 days", "use all tokens before Friday"). The harness treats it as a hint
  to the user/agent, not a machine-parseable number.
- `timeline.start` / `timeline.target` are ISO dates. No time component needed
  at project granularity; daily resolution is sufficient.
- `created` / `updated` are ISO 8601 UTC timestamps so the harness can sort
  projects by recency and detect stale ones.

---

## 2. `tasks/<id>.yaml` — Task Files

**Why individual files instead of a single `tasks.md`?**

`tasks.md` is good for quick human review but hard to update atomically. When
two sub-agents (or the harness and a sub-agent) update tasks concurrently,
a single file creates merge conflicts. Individual files mean:

- Each task is an independent unit of work on the filesystem.
- `ls tasks/` gives a quick count and ID list.
- `cat tasks/HARNESS-001.yaml` gives full context on one task.
- The harness can assign a task by writing only that file, with no risk of
  clobbering another task.

**Why a Jira-like ID scheme (`PROJECT-NNN`)?**
Short, unique, survives copy-paste across documents and conversations. The
project prefix (`HARNESS`) makes it obvious which project a task belongs to
when IDs appear in logs or messages.

**Status state machine:**

```
backlog → assigned → in-progress → review → done
```

- `backlog`: known but not started
- `assigned`: a sub-agent or user has been given the task
- `in-progress`: actively being worked
- `review`: work complete, awaiting acceptance
- `done`: accepted and closed

This matches the IPC protocol already in use: a sub-agent writes `status.md`
as it works and `result.md` when done. The harness transitions the task from
`in-progress` to `review` when `result.md` appears, and to `done` after the
user/agent accepts.

**`deliverables` field:**
Explicit expected outputs let the harness verify completion automatically:
check that each listed path exists after the sub-agent finishes. Avoids the
common problem of "done" meaning "I think I'm done" vs. "the artifact exists."

**`parent` field:**
Supports subtask hierarchies (epics → stories → tasks) without requiring a
separate file type. A null parent means top-level. The harness can reconstruct
the tree by querying all tasks with `parent: HARNESS-001`.

---

## 3. `resources.yaml` — Resource Registry

**Why a single file at the harness root (not per-project)?**
Resources are shared across projects. A token budget is a global constraint —
two projects competing for the same account need to be scheduled against the
same pool. Putting it at the root makes that global scope explicit.

**Why placeholder/null fields for usage?**
The harness doesn't have API access to query token usage yet. Placeholder
fields (`usage_estimate: null`) signal intent without blocking the rest of the
schema. When the query is wired up, only this file changes.

**`token_windows` section:**
Separates the _account credential_ (who am I) from the _scheduling window_
(how much can I do before I need to wait). Future: multiple windows per account
(e.g., hourly burst + daily total), multiple accounts for parallel workloads.

---

## 4. Conventions Borrowed from PKB

The PKB uses `projects/<name>/README.md` + `tasks.md` as the baseline. This
schema extends that pattern:

- `project.yaml` sits alongside `README.md` — prose and metadata co-located.
- `tasks/` replaces the flat `tasks.md` for machine-managed state while
  `tasks.md` remains for human-authored notes (the harness will reconcile them
  on a future pass).
- Notes go in `notes/YYYY-MM-DD-topic.md` — same date-prefixed convention as
  the PKB for easy chronological browsing.

---

## 5. What This Does Not Cover (Future Work)

- **CLI tools** for creating/updating tasks and projects (`harness task create`)
- **Resource allocation** — mapping tasks to specific accounts/machines
- **Token budget queries** — polling the Anthropic API or parsing Claude Code
  output to estimate remaining usage
- **Subtask rollup** — aggregating child task statuses to update parents
- **Archival** — moving `done` tasks to an `archive/` subdirectory
