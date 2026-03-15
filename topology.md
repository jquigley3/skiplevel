# Harness Topology

## Core Model

```typescript
// Session: atomic unit of execution. Everything else exists to schedule and manage sessions.
interface Session {
  // Identity
  id?: string; // persistent mode only; Claude Code UUID; owned by Claude Code
  mode:
    | 'ephemeral' // claude -p "..."; single run; no resume; output only
    | 'persistent'; // claude [--resume id]; UUID; resumable; retains history

  // Environment (how the session is provisioned)
  env: {
    type:
      | 'local' // claude process on host
      | 'docker' // claude inside Docker container
      | 'worktree' // git worktree isolation + local claude
      | 'apple-container'; // Apple Container VM (macOS)
    working_dir: string; // claude's working directory; scopes file access
    context_files: string[]; // CLAUDE.md files loaded; defines agent behavior + tools
    credentials: string; // how ANTHROPIC credentials are provided
  };

  // Lifecycle
  state:
    | 'running'
    | 'stopped:output' // completed; launcher reads output → decides next action
    | 'stopped:needs-input'; // paused; launcher must provide input to continue
}

// Launcher: whoever starts or resumes a session. Observes session state and acts.
type Launcher = 'human' | 'orchestrator' | 'parent-session';

// Launcher decision loop (same regardless of launcher type):
//   session stops →
//     stopped:output     → inspect output → { launch new session | update task | notify human | done }
//     stopped:needs-input → { resume same session with answer (persistent)
//                           | launch new session with answer embedded (ephemeral) }

// Task: unit of work; describes what one session should accomplish.
interface Task {
  id: string; // PROJECT-NNN
  description: string; // self-contained; the only context the session needs
  status:
    | 'backlog' // defined, not scheduled
    | 'queued' // scheduled; orchestrator will dispatch
    | 'in-progress' // session running
    | 'review' // session stopped:output; awaiting acceptance
    | 'done'; // accepted
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  agent_spec?: Partial<Session['env']>; // requested environment; orchestrator may override
  deliverables: string[]; // paths expected on completion; presence = done signal
  parent?: string; // task ID; enables task trees
  result?: string; // path to ipc/result.md written by session
}

// Task state machine:
//   backlog → queued → in-progress → review → done
//                                      ↓ (rejected)
//                                   in-progress  (revision loop)

// Project: mutable goal + task collection.
interface Project {
  id: string;
  goal: string; // intentionally mutable; evolves as user develops project
  status: 'planning' | 'active' | 'paused' | 'done';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  tasks: Task[]; // files: tasks/PROJECT-NNN.yaml
  session_id?: string; // linked persistent planning session (the "project session")
}

// Orchestrator: persistent process (Node.js daemon). Not AI; pure scheduling.
// Responsibilities:
//   - watch tasks/ for status=queued
//   - select by project.priority → task.priority
//   - check resource availability (token window, max_concurrent)
//   - provision session per task.agent_spec; set status=in-progress
//   - watch for ipc/result.md → set status=review
//   - when all project tasks in {review|done|failed} → set linked session state=blocked

// Resource constraints
interface TokenWindow {
  account: string;
  remaining: number | null; // null = unknown; proceed optimistically; CLI errors if exhausted
  resets_at: string | null; // ISO 8601
  min_task_tokens: number; // don't dispatch if remaining < this
}
```

## File Layout

```
<harness-root>/
  topology.md                    ← this file
  resources.yaml                 ← machines, accounts, token windows, sessions, allocation
  projects/<id>/
    project.yaml                 ← Project
    CLAUDE.md                    ← session behavior definition (tools, persona, slash commands)
    tasks/PROJECT-NNN.yaml       ← Task (one file per task; atomic updates)
    ipc/
      status.md                  ← session writes progress
      result.md                  ← session writes output; triggers review transition
    notes/                       ← design docs, decisions (human-readable)
```

## Session ↔ Planning Model Mapping

```
User (human)           = Launcher type=human; drives persistent top-level session
Head of Engineering    = persistent project session; plans, dispatches, reviews
Sub-agent / IC         = ephemeral session; executes one task; writes ipc/result.md
Orchestrator           = Launcher type=orchestrator; dispatches sub-agent sessions
```
