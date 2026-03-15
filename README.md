# ClawForge

**Status:** Planning

> Agent harness for managing multiple Claude Code CLI instances.
> **Started:** 2026-03-14
> **Goal:** Build a harness for managing multiple Claude Code CLI instances, modeled on an engineering organization.

## Overview

A system where:

- **User** (CEO) sets goals and priorities
- **Agent** (Head of Engineering) plans, schedules, and delegates
- **Sub-agents** (Project Managers / ICs) execute scoped work in sandboxes

The harness manages: project definitions, resource tracking (machines, API tokens, token windows), scheduling, state tracking, and delegation to sandboxed Claude Code CLI instances.

## Key Concepts

- **Projects** have priority, scope estimates, and timelines
- **Resources** are physical machines, Claude API/CLI accounts, token budgets
- **Scheduling** allocates resources to projects based on priority and constraints
- **Delegation** breaks projects into sub-agent-sized work units
- **State tracking** follows Agile patterns: epics → stories → tasks, visible like a Jira board
- **Review/feedback** are just more tasks assigned to agents with different goals

## Architecture (Planned)

- Project state stored on filesystem (one dir per project, like PKB)
- Agent harness is a CLI tool or script that orchestrates Claude Code CLI instances
- Sub-agents run in Apple sandbox (`sandbox-exec`) with scope limited to their project
- State files track progress, token usage, resource allocation
- Dogfooded: this project is the first managed by the system

## Sandbox Model

Sub-agents run via `sandbox-exec` with a profile that:

- Allows read/write to the assigned project directory
- Allows read-only access to shared resources (PKB, harness config)
- Allows network (Claude API)
- Denies access to everything else (home dir, other projects, system)

## Resources

- macOS workstation with `sandbox-exec`
- Claude Code CLI 2.1.76
- PKB at `/Users/josh/claude/pkb/`

---

[ClawForge on GitHub](https://github.com/jquigley3/clawforge)
