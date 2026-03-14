# Orchestrator Need

**Date:** 2026-03-14

## Problem

The current model blocks the top-level Claude Code CLI session while sub-agents run. This means:
- User can't do other work in the same session
- If user closes the session, sub-agents may be orphaned
- No way for sub-agents to continue working while user is away (overnight, etc.)
- The "head of engineering" role can't be played by an ephemeral CLI session

## Implication

Claude Code CLI is the right **interface** for the user (CEO) to interact with the system, but it cannot be the **orchestrator** (head of engineering). The orchestrator needs to be a persistent process.

## Options to evaluate

1. **Node.js daemon** — similar to NanoClaw. Manages Docker containers, tracks state, exposes an interface for the CLI to connect to. Could potentially reuse NanoClaw's container-runner.

2. **Shell daemon + launchd/systemd** — simpler, just a bash script that reads task queue and spawns `docker run` commands. State tracked via files. Less code but less capability.

3. **Claude Code in headless mode** — `claude -p` can run non-interactively. Could be launched by launchd as a recurring job. But each invocation is a fresh context — no persistent state beyond files.

4. **Hybrid** — lightweight daemon handles scheduling and container lifecycle. Claude Code CLI is used for planning and review (user-facing). The daemon doesn't need to be AI-powered — it just dispatches tasks and collects results.

## Likely direction

**Build on NanoClaw.** It already solves the orchestrator problem:
- Persistent Node.js process (launchd/systemd)
- Container runner with credential proxy, mount security
- Task scheduler for recurring jobs
- Multi-channel input (WhatsApp, Telegram, Slack, etc.)

What's needed:
- A **CLI channel** as the primary input for planning and review
- Extend the task scheduler to manage `tasks/*.yaml` queue
- Map NanoClaw concepts: group = project, scheduled tasks = harness task dispatch
- **WhatsApp as CEO status channel** — natural fit for "how's the project going?" while on the go

This avoids building a parallel orchestrator and reuses battle-tested container management. The agent harness becomes a NanoClaw capability, not a separate system.
