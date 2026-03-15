# IPC Design: Host Agent ↔ Sub-Agent Communication

## Constraints

- Shared filesystem (Docker bind mount)
- Both sides are Claude Code CLI instances with file read/write
- Must avoid concurrent write collisions
- Sub-agent runs in container, host agent runs natively
- MVP: one sub-agent at a time (sequential)

## Approach: File-based mailbox

Each sub-agent gets an `ipc/` directory inside its project folder. Communication uses atomic file writes with a simple convention:

```
project-dir/
  ipc/
    task.md          # Host → Sub-agent: current task assignment (written before launch)
    status.md        # Sub-agent → Host: progress updates (sub-agent writes)
    result.md        # Sub-agent → Host: final deliverable summary (sub-agent writes on completion)
```

### Protocol

1. **Host writes `ipc/task.md`** before launching the sub-agent. Contains:
   - Task description
   - Success criteria
   - Scope boundaries (what NOT to do)
   - Expected deliverables

2. **Host launches sub-agent** with `--print` or `-p` flag, pointing it at `ipc/task.md`:

   ```
   run.sh <project-dir> -p "Read /workspace/project/ipc/task.md and execute the task described.
   Write progress to /workspace/project/ipc/status.md as you work.
   When done, write a summary to /workspace/project/ipc/result.md."
   ```

3. **Sub-agent reads task, works, writes status/result** to the ipc directory.

4. **Host reads `ipc/result.md`** after the container exits.

### Why not git for IPC?

Git is for sharing _project state_ across agents over time. IPC is ephemeral task-level communication within a single agent invocation. Files in `ipc/` are transient — they can be cleaned up between runs.

### Future: concurrent agents

When multiple sub-agents run in parallel, each gets its own `ipc/<agent-id>/` subdirectory. No shared writes.
