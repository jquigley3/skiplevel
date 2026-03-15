# Design Rationale: Resource Model

**Date:** 2026-03-14
**Task:** HARNESS-002

## Overview

This document explains the schema choices for `resources.yaml` — the harness's
global resource registry. It covers machines, accounts, token windows, and
resource-to-project allocation.

---

## 1. Four Top-Level Sections

`resources.yaml` is organized into four sections: `machines`, `accounts`,
`token_windows`, and `allocation`. Each represents a distinct concern:

| Section         | Question it answers                         |
| --------------- | ------------------------------------------- |
| `machines`      | Where can sub-agents run?                   |
| `accounts`      | What credentials are available?             |
| `token_windows` | How much of the budget is left right now?   |
| `allocation`    | Which project uses which machine + account? |

Keeping these separate avoids conflating static configuration (machines,
accounts) with dynamic runtime state (token windows, current usage). The
static sections change rarely; the dynamic sections are updated frequently
by the harness at runtime.

---

## 2. `machines` — Compute Resources

**Why model machines at all?**

The MVP runs on a single macOS workstation, so a machine model feels like
over-engineering. But two near-term scenarios make it necessary:

1. **Multiple machines**: Adding a Linux VM or cloud instance means the
   scheduler needs to know where Docker is available and what capabilities
   each host has.
2. **Capability gating**: `sandbox-exec` only exists on macOS; certain
   container configurations require specific OS features. The `capabilities`
   list lets the scheduler filter machines that can run a given task type.

**`status` field:**
`available | busy | offline | reserved` gives the scheduler a quick signal
without querying the machine. The harness updates this field when it spawns
or terminates agents. `reserved` is for machines explicitly held for a
specific project (e.g., a high-priority overnight run).

**`type` field:**
`workstation | server | vm | ci-runner` captures the operational context.
A workstation may be unavailable when the user's laptop is closed; a server
is expected to be always-on. The scheduler can use this to decide whether
to wait or fail over.

---

## 3. `accounts` — Credentials

**Why `id` in addition to `name`?**

`id` is a machine-readable slug (`claude-personal`) used as a foreign key in
`token_windows` and `allocation`. `name` is the human-readable label shown in
logs and UI. Keeping them separate avoids breaking references if the name changes.

**`machine` field:**
Credentials live on specific machines (OAuth tokens in the macOS keychain;
API keys in environment files). The `machine` field records where to find the
credential at launch time. For API keys stored in a vault, this would point to
the vault location instead.

**`token_budget` nested under `account`:**
Static budget metadata (plan type, refresh schedule, known limits) lives on
the account because it describes the account's contract with Anthropic, not
runtime state. Dynamic state (current usage, tokens remaining) belongs in
`token_windows`.

**`plan` field:**
`free | pro | max | api` affects what limits apply. Pro and Max have
daily token limits that reset on a schedule; API accounts are billed
per-token with no hard daily cap (but cost matters). The scheduler uses
this to apply appropriate safety margins.

**`usage_limit: null`:**
Pro plan limits are not publicly documented as a precise token count and
aren't exposed via API as of 2026-03. `null` is honest — the harness
doesn't know the exact cap. When Anthropic exposes this via API, this
field gets populated automatically.

---

## 4. `token_windows` — Scheduling Constraints

**Why separate from `accounts`?**

An account has a static contract (plan, refresh schedule). A token window
is a dynamic snapshot: "right now, this account has ~X tokens left until
midnight." Separating them:

- Makes it clear which fields the harness writes at runtime vs. which are
  set once by the operator.
- Supports future scenarios: one account could have multiple windows (hourly
  burst limit + daily total), each tracked independently.

**`min_task_tokens` field:**
The minimum token budget required to attempt launching a new sub-agent.
Without this, the harness might launch a sub-agent that immediately fails
mid-task because the budget ran out. Setting a floor (e.g., 10,000 tokens)
ensures there's enough headroom to do meaningful work.

The value is intentionally conservative. A sub-agent reading files and
writing a design document might use 5,000–15,000 tokens. 10,000 tokens as
the minimum means the harness won't launch if there's clearly not enough,
but accepts some risk near the boundary. Operators can tune this per-account.

**`tokens_remaining: null` means proceed:**
When runtime state hasn't been populated yet (first run, no usage query
wired up), `null` is treated as "assume available." This fails open rather
than blocking all work until instrumentation is in place. The downside is a
possible mid-task failure; the upside is the system works before full
monitoring is built.

**`window_type: daily`:**
The Claude Pro plan resets daily. `hourly` and `rolling-30d` are defined
for forward compatibility (e.g., API rate limits or future plan tiers with
different windows). The scheduler uses `window_type` to know how to interpret
`next_refresh`.

---

## 5. `allocation` — Resource-to-Project Mapping

**Why a `default` allocation?**

Most projects will use the same machine and account. Having a single default
means new projects don't require any allocation configuration — they inherit
automatically. Only exception projects need an explicit override.

**`max_concurrent_agents: 1`:**
The MVP is sequential. One sub-agent runs at a time, uses the full token
budget, and completes before the next starts. This is the safe baseline that
avoids token budget conflicts and concurrent write issues.

When parallel workloads are needed, `max_concurrent_agents` is raised and
the scheduler must partition the token budget across concurrent agents
(e.g., 3 agents × 33% budget each = same total).

**`per_project` overrides:**
An empty list for now, but the schema supports future cases:

- A high-priority project that must always run on a specific machine
- A project with its own API key (separate token budget)
- A project limited to 1 agent even when the default allows more

**`priority_boost`:**
Documented in a comment example (not active). When multiple projects compete
for the same resource pool, priority-boosted projects jump the queue. This
aligns with the P0–P3 priority system on tasks and projects.

---

## 6. Global vs. Per-Project Placement

The current `resources.yaml` lives inside the `agent-harness` project
directory because agent-harness is the harness — there's no separate harness
root yet. When the harness manages multiple projects in sibling directories,
`resources.yaml` should move to a root-level harness config directory:

```
harness/
  resources.yaml          ← global resource pool
  projects/
    agent-harness/
    complaint-automator/
    ...
```

The schema doesn't need to change; only the file location moves.

---

## 6. `sessions` — User Session Tracking

**Added in:** HARNESS-005 (2026-03-14)
**Rationale source:** `notes/2026-03-14-session-flow.md`

**Why model sessions as resources?**

Sessions are a resource the harness must track to enable the core user workflow:
the user interleaves multiple Claude Code sessions (a top-level planning session
and per-project sessions), switches between them, and needs to resume the right
one at the right time. Without a sessions registry, the harness has no way to
answer "which sessions exist, which are blocked, and which can be safely ignored
right now."

Sessions belong in `resources.yaml` rather than in project-level state files
because they span projects. The top session has no project affiliation, and a
user might later want to list all sessions across all projects in one view.

**`state` field — four values:**

| State         | Meaning                                             |
| ------------- | --------------------------------------------------- |
| `interactive` | User is actively present in this session            |
| `autonomous`  | Sub-agent tasks are running; user can switch away   |
| `blocked`     | Tasks are done or failed; needs user attention      |
| `idle`        | No active tasks; session exists but nothing pending |

These four states encode the full lifecycle described in `session-flow.md`. The
scheduler and notification system use `blocked` sessions as the primary signal
that user attention is needed.

**`active_tasks` field:**
A list of task IDs dispatched during the current autonomous phase. When all
tasks reach `review` or a terminal state, the harness transitions the session
to `blocked`. This list is cleared when the user reviews and re-scopes.

**`blocked_reason` field (nullable):**
Human-readable string explaining why a session is blocked. `null` when not
blocked. Populated by the harness when a task fails (`"HARNESS-003 failed:
sandbox permission error"`) or when a sub-agent explicitly signals a decision
point.

**`project` field (nullable):**
Soft foreign key to a project `id`. Nullable because the top session has no
project. Not enforced by the harness — a session could be scoped to a directory
that doesn't map cleanly to a registered project.

**`id: null` as default:**
Session UUIDs are assigned by Claude Code, not by the harness. The harness
records them after session creation. `null` means "not yet created / UUID not
yet recorded." This is the same fail-open pattern used in `token_windows`.

**Why not store sessions per-project?**
Project-level state files (`project.yaml`) track tasks, epics, and milestones.
Sessions are orthogonal: one session can touch multiple projects (top session),
and multiple sessions can exist for one project (e.g., one interactive, one
reviewing a sub-agent result). Keeping sessions in the global resource registry
avoids duplicating session state across project files.

---

## 7. What This Does Not Cover (Future Work)

- **Runtime update mechanism**: how does the harness query current token usage
  and write it back to `token_windows`? Options: parse `claude` CLI output,
  poll usage.anthropic.com, or instrument API calls via a credential proxy.
- **Machine health checks**: detecting when a machine goes offline and
  rescheduling its tasks to another host.
- **Cost tracking**: for API-key accounts, tracking spend (USD) alongside
  token counts.
- **Multi-account parallelism**: splitting a project's sub-agents across two
  accounts to double throughput (each gets its own token window).
- **Credential rotation**: when OAuth tokens expire mid-run, the harness
  needs to refresh them without interrupting the sub-agent.
