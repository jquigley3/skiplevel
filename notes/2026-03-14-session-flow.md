# Session Flow Design

## Overview

The user's experience is **multiple interleaved sessions**. From Claude Code's
perspective, each is one interrupted session that gets resumed. The harness
manages the lifecycle and state transitions.

## Session Types

### Top Session
- The entry point. User launches `claude` in the harness root directory.
- Purpose: cross-project planning, prioritization, adding/removing projects.
- This session is long-lived and rarely "done" — it's the CEO's desk.

### Project Session
- Scoped to a single project directory (e.g. `pkb/projects/agent-harness/`).
- Created when the user decides to focus on a specific project.
- Uses `claude --resume <session-id>` to return to an ongoing conversation
  with full context preserved.
- The directory scope naturally constrains the agent's attention to that
  project, but this is the user's choice — they may prefer a top-level dir
  if they want to jump between projects in one session.

## Flow

### 1. Start in the Top Session
```
$ claude
> "Let's look at what needs attention across projects"
> [harness shows project statuses, blocked items, priorities]
> "Let's work on agent-harness next"
```

### 2. Create a Project Session
The top session can fork into a project session. This is natural because the
conversation flows from "planning across projects" into "discussing a specific
project" — forking preserves the context that led to the decision.

```
> "Let's scope the scheduler task for agent-harness"
> [discussion, requirements clarification]
> [harness forks session, scoped to projects/agent-harness/]
```

Implementation: `claude --fork-session --add-dir <project-dir>` or launch a
new `claude -n "agent-harness" --session-id <uuid>` in the project directory.
The harness records the session ID and links it to the project.

### 3. Transition to Autonomous
Once requirements are clear, the user says "go" (or equivalent). The harness:
- Creates task YAML files from the scoped work
- Sets tasks to `assigned` so the orchestrator picks them up
- Marks the session state as `autonomous`
- The user can close the terminal or switch away

### 4. Work on Something Else
The user returns to the top session (or picks another project session):
```
$ claude --resume
> [session picker shows:]
>   agent-harness     [autonomous - 2 tasks running]
>   complaint-automator [blocked - needs decision on auth flow]
>   inbox-service     [idle]
> [user picks complaint-automator]
```

### 5. Handle Blocked Sessions
A session becomes `blocked` when:
- All dispatched sub-agent tasks reach `review` status
- A sub-agent explicitly signals "need user decision" (future)
- A task fails and needs human judgment

The user's workflow for multiple autonomous projects is: **work through each
blocked session**, make decisions, re-scope, say "go" again, move to the next.

This is the core loop:
```
for each blocked session:
    resume session
    review sub-agent results
    make decisions / provide input
    either: delegate more work (-> autonomous)
       or: mark project milestone complete (-> idle)
```

### 6. Notifications
When a session transitions to `blocked`, the user should be notified:
- Terminal: badge/bell if session is in background
- NanoClaw/WhatsApp: "agent-harness tasks complete, ready for review"
- Dashboard: session state visible at a glance (future)

## Key Principle

**The user is the bottleneck.** The system maximizes the value of user
attention by:
- Keeping context warm (session resume, not re-explain)
- Clearly signaling what needs attention (blocked sessions)
- Running everything else autonomously in the background
- Never losing the thread of a project conversation

## Data Model

Sessions are tracked as resources alongside machines and accounts:

```yaml
sessions:
  - id: <claude-code-session-uuid>
    name: agent-harness              # display name for picker
    project: agent-harness           # linked project (soft, not enforced)
    directory: /path/to/project      # working directory for the session
    state: autonomous                # interactive | autonomous | blocked | idle
    active_tasks:                    # tasks dispatched in current autonomous phase
      - HARNESS-003
      - HARNESS-004
    blocked_reason: null             # human-readable reason when blocked
    last_interaction: 2026-03-14T10:30:00Z
```

The top session is just another session entry with no specific project link:

```yaml
  - id: <top-session-uuid>
    name: top
    project: null
    directory: /Users/josh/claude/pkb/projects/agent-harness
    state: interactive
    active_tasks: []
    blocked_reason: null
    last_interaction: 2026-03-14T10:00:00Z
```

## Onboarding & Guided Prompting

The system should be **heavily prompted** during early use. Users are engineers
but the multi-session workflow (top session, project sessions, autonomous mode,
blocked queue) is novel. The agent should:

- Suggest next actions: "You have 2 blocked sessions. Want to review them?"
- Explain transitions: "I'll create 3 tasks and switch to autonomous mode.
  You can resume this session later when they're done."
- Offer slash commands: "Tip: you can use `/go` to dispatch directly."
- Surface state: "This session has been idle for 2 days. Want to check on
  sub-agent progress?"

This prompting is the onboarding flow — it teaches users the system by showing
them what's possible in context. As users become fluent, the prompts can be
reduced (configurable verbosity or learned from user feedback).

### CLAUDE.md as the Behavior Definition

All of this behavior — the session lifecycle, slash commands, prompting style,
state transitions, when to ask vs. act — lives in a project-level `CLAUDE.md`
file. When a user starts fresh:

1. The harness project includes a `CLAUDE.md` that defines the agent's
   personality and workflow (session management, task dispatch, onboarding
   prompts, slash commands like `/go`, `/status`, `/blocked`).
2. Claude Code reads `CLAUDE.md` on startup and behaves accordingly.
3. No custom code needed for the agent behavior — `CLAUDE.md` IS the program.
   The orchestrator handles infrastructure (containers, task queue), but the
   user-facing intelligence is prompt-driven.

This means the harness is two things:
- **Infrastructure**: orchestrator, containers, task YAML, IPC (TypeScript)
- **Behavior**: `CLAUDE.md` that shapes how Claude interacts with the user
  (prompt engineering)

The `CLAUDE.md` is versioned and iterable — improving the user experience is
a matter of editing the prompt, not shipping code.

## Implementation Notes

- Fork vs. new session: `--fork-session` carries context but stays in the same
  directory. A new session in a project directory starts fresh but is naturally
  scoped. The right choice depends on how much context from the top session is
  needed — the harness should offer both.
- Session IDs are Claude Code UUIDs. The harness stores them but does not
  generate them — Claude Code owns the session lifecycle.
- The orchestrator doesn't need to know about sessions. It watches task YAML
  files. Sessions are a user-facing concept layered on top.
- The "go" command is the transition point. Two trigger modes:
  1. **Slash command** (`/go`) — explicit, preferred by engineers. Immediately
     creates tasks and transitions to autonomous.
  2. **Natural language** — when the user says something like "this is ready to
     delegate" or "let's run this", the agent recognizes intent and uses
     `AskUserQuestion` to confirm: "Ready to dispatch 3 tasks to sub-agents
     and switch to autonomous mode. Go? [Y/n]". Claude Code CLI has
     `AskUserQuestion` as a built-in tool for exactly this pattern.
  General principle: slash commands for direct actions, natural language
  triggers should _suggest_ the action with a yes/no prompt.
