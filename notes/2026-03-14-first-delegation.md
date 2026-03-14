# First Sub-Agent Delegation

**Date:** 2026-03-14

## What happened
Successfully delegated HARNESS-001 (design project state schema) to a sub-agent running in a Docker container. The sub-agent read the task from `ipc/task.md`, executed it, and wrote results back.

## Deliverables produced
- `project.yaml` — project metadata (status, priority, scope, timeline)
- `tasks/HARNESS-001.yaml` through `HARNESS-003.yaml` — Jira-style task tickets
- `resources.yaml` — API account + token window tracking
- `notes/2026-03-14-state-model.md` — design rationale

## Review notes
- Schema is solid and usable as-is, can evolve
- `resources.yaml` should live at the harness root level (above any single project) since it's a global resource — for now it's fine in the project dir while agent-harness IS the harness
- `deliverables` paths in task YAML use container paths (`/workspace/project/...`) instead of relative paths — should be relative for portability
- Sub-agent correctly followed all scope constraints (didn't modify existing files, read PKB as read-only)

## Process observations
- Writing a clear `task.md` with explicit scope/deliverables/constraints is critical
- The sub-agent produced good design rationale unprompted — useful for future agents picking up the work
- Total time: ~2 minutes for a meaningful design task
