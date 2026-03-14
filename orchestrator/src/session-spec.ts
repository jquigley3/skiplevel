/**
 * Session specification types for the agent harness orchestrator.
 *
 * AgentSpec     — the optional `agent_spec:` block in a task YAML
 * SessionConfig — fully-resolved input to SessionBuilder (task + defaults merged)
 * SpawnSpec     — the output of SessionBuilder.build(): ready to pass to spawn()
 */

// ---------------------------------------------------------------------------
// AgentSpec — task-authored, all fields optional
// ---------------------------------------------------------------------------

export interface AgentSpec {
  // Execution environment
  isolation?: 'docker' | 'local' | 'worktree' | 'apple-container';
  image?: string;       // Docker/Apple Container image name
  timeout_ms?: number;

  // Claude CLI flags
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  max_turns?: number;
  permission_mode?: 'default' | 'plan' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions';
  max_budget_usd?: number;
  system_prompt?: string;        // replaces default system prompt
  append_system_prompt?: string; // appended to default system prompt

  // Tool access
  allowed_tools?: string[];      // --allowedTools: execute without prompting
  disallowed_tools?: string[];   // --disallowedTools: remove from context

  // Session identity
  session_name?: string;         // --name: display label
  no_session_persistence?: boolean; // --no-session-persistence

  // MCP servers — inline JSON string, written to a temp file at resolve time
  mcp_config?: string;
  strict_mcp_config?: boolean;

  // File overrides (paths relative to project dir or absolute)
  // docker: mounted into the container; local: used directly
  claude_md?: string;     // overrides /workspace/project/CLAUDE.md in container
  settings_json?: string; // overrides /home/node/.claude/settings.json in container

  // Additional mounts (docker/apple-container only)
  // Container path must start with /workspace/ and must not contain ..
  extra_mounts?: Array<{
    host: string;
    container: string;
    readonly?: boolean;
  }>;

  // Extra environment variables passed to the sub-agent process
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// WorktreeInfo — returned by createWorktree in orchestrator.ts
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;   // absolute path to the worktree directory
  branch: string; // branch name: agent/<taskId>-<suffix>
}

// ---------------------------------------------------------------------------
// SessionConfig — fully resolved; SessionBuilder input
// ---------------------------------------------------------------------------

export interface SessionConfig {
  // Identity & paths
  taskId: string;
  projectDir: string;   // absolute path on orchestrator filesystem
  workDir: string;      // absolute path (worktree or projectDir)
  hostWorkDir: string;  // workDir translated to host path (for docker -v flags)
  ipcDir: string;       // path.join(workDir, 'ipc')
  suffix: string;       // random hex suffix shared with container/worktree name
  containerName: string; // harness-<taskId-lower>-<suffix>

  // Execution strategy
  isolation: 'docker' | 'local' | 'worktree' | 'apple-container';
  image: string;
  timeout_ms: number;

  // Claude CLI flags (undefined = omit the flag)
  model?: string;
  effort?: string;
  max_turns?: number;
  permission_mode: string; // always set (defaults to bypassPermissions)
  max_budget_usd?: number;
  system_prompt?: string;
  append_system_prompt?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  session_name?: string;
  no_session_persistence: boolean;

  // MCP config: written to a temp file in ipcDir at resolve time.
  // mcp_config_file: the orchestrator-side path used for writing.
  // For docker, SessionBuilder converts this to the container-side path for --mcp-config.
  mcp_config_file?: string;
  strict_mcp_config?: boolean;

  // File overrides: resolved absolute host paths
  settings_file?: string;  // resolved path to settings.json override
  claude_md_path?: string; // resolved path to CLAUDE.md override

  // Validated extra mounts
  extra_mounts: Array<{ host: string; container: string; readonly: boolean }>;

  // Environment for the spawned process
  env: Record<string, string>;
}

// ---------------------------------------------------------------------------
// SpawnSpec — SessionBuilder output; pass directly to spawn()
// ---------------------------------------------------------------------------

export interface SpawnSpec {
  command: string[];           // argv; command[0] is the binary (docker/claude/container)
  env: Record<string, string>; // process env for spawn()
  workdir: string;             // cwd for spawn()
  timeout_ms: number;
  containerName?: string;      // present for docker and apple-container strategies
}
