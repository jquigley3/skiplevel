# Worktree Isolation for Sub-Agents

## Problem

When multiple sub-agents run against the same project directory, they share
one working tree. This causes:

- Concurrent write conflicts (two agents editing the same file)
- Dirty git state that bleeds between tasks
- No clean audit trail of "what did this agent change?"

## Solution: Git Worktrees

Each dispatched task gets its own git worktree — a separate checkout of the
same repo, on a dedicated branch. The sub-agent container mounts the worktree
directory instead of the project root.

```
/workspace/
  projects/
    agent-harness/        ← main project repo (HEAD = main)
  worktrees/
    HARNESS-009/          ← worktree for this task (branch = agent/HARNESS-009)
    HARNESS-010/          ← another task running concurrently
```

## Lifecycle

```
1. dispatchTask()
     createWorktree(projectDir, taskId)
       → git worktree add ../worktrees/<taskId> -b agent/<taskId>
       → returns /workspace/worktrees/<taskId>

2. Container launch
     -v <host-worktree-path>:/workspace/project
     (instead of the project root)

3. Sub-agent runs inside the worktree
     Reads task from /workspace/project/ipc/task.md
     Writes changes, commits to branch agent/<taskId>
     Writes result to /workspace/project/ipc/result.md

4a. Success → task moves to `review`
     Worktree is PRESERVED — reviewer merges agent/<taskId> → main, then
     manually removes the worktree (or orchestrator does on `done`).

4b. Failure / error → task returns to `assigned`
     removeWorktree() is called immediately — no partial branch to confuse
     the next attempt.
```

## Host Path Translation

The orchestrator runs inside Docker. Docker volume mounts require HOST paths,
not the orchestrator-container paths. `toHostPath()` applies the same
`PROJECTS_DIR → HOST_PROJECTS_DIR` prefix substitution to worktree paths.

Example:
```
Container sees:  /workspace/worktrees/HARNESS-009
Host mount:      /Users/foo/harness/worktrees/HARNESS-009
```

Both live under the same parent directory on both sides, so the substitution
is a simple prefix replace.

## Fallback

If the project directory is not a git repo, `createWorktree()` returns `null`
and the orchestrator falls back to the existing behavior (mount the project dir
directly). A warning is logged. This preserves backward compatibility for
projects that haven't been git-initialized yet.

## Merge / Cleanup

After review:
1. User (or orchestrator review step) runs:
   ```
   git merge --no-ff agent/<taskId>
   # or: git rebase main
   ```
2. Delete the worktree:
   ```
   git worktree remove worktrees/<taskId>
   git branch -d agent/<taskId>
   ```

The `removeWorktree()` helper in the orchestrator does both steps. The
orchestrator calls it on failure. For successful tasks the user triggers it
during review, or the orchestrator can call it after a `done` transition
(future work).

## Relation to "Ensure each project has git initialized"

The old tasks.md item ("Ensure each project has git initialized before first
task dispatch") is superseded by this worktree approach. We no longer need a
separate initialization step — `createWorktree()` checks for git and falls back
gracefully. The real fix is to initialize git at project creation time, which
is covered by the CLI/project CRUD tasks in Phase 1.
