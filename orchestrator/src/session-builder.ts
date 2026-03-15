/**
 * SessionBuilder — translates a resolved SessionConfig into a SpawnSpec
 * (a command + env + workdir ready to pass to Node's spawn()).
 *
 * Strategies:
 *   docker           — `docker run` with bind mounts (current default)
 *   apple-container  — `container run` with bind mounts (Apple Container VMs)
 *   local            — `claude` directly on the host, no container
 *   worktree         — same as local; workDir is a pre-created git worktree
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  HARNESS_NETWORK,
  PROJECTS_DIR,
  HOST_PROJECTS_DIR,
  HOST_PKB_DIR,
  PKB_DIR,
  TIMEZONE,
} from './config.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateMount } from './mount-security.js';
import { logger } from './logger.js';
import {
  AgentSpec,
  SessionConfig,
  SpawnSpec,
  WorktreeInfo,
} from './session-spec.js';
import { TaskFile } from './task-loader.js';

// Apple Container uses a different hostname to reach the host machine.
const APPLE_CONTAINER_HOST_GATEWAY = 'host.containers.internal';

// ---------------------------------------------------------------------------
// resolveSessionConfig — merge task + agent_spec + defaults into SessionConfig
// ---------------------------------------------------------------------------

export function resolveSessionConfig(
  task: TaskFile,
  worktree: WorktreeInfo | null,
  suffix: string,
): SessionConfig {
  const spec: AgentSpec = task.agent_spec ?? {};
  const projectDir = task.projectDir;
  const workDir = worktree?.path ?? projectDir;
  const containerName = `harness-${task.id.toLowerCase()}-${suffix}`;

  // Translate orchestrator-side workDir to host path (docker mounts need host paths).
  // When the orchestrator itself runs in Docker, PROJECTS_DIR is the container path
  // and HOST_PROJECTS_DIR is the corresponding host path.
  const hostWorkDir = worktree
    ? toHostPath(worktree.path)
    : path.join(HOST_PROJECTS_DIR, task.project);

  const ipcDir = path.join(workDir, 'ipc');
  fs.mkdirSync(ipcDir, { recursive: true });

  // Write inline mcp_config JSON to a temp file so we can pass it via --mcp-config.
  // The file lives in ipcDir which is already mounted into the container.
  let mcp_config_file: string | undefined;
  if (spec.mcp_config) {
    const mcpPath = path.join(ipcDir, `.mcp-config-${suffix}.json`);
    fs.writeFileSync(mcpPath, spec.mcp_config);
    mcp_config_file = mcpPath;
  }

  // Resolve file override paths relative to projectDir
  const settings_file = spec.settings_json
    ? path.resolve(projectDir, spec.settings_json)
    : undefined;
  const claude_md_path = spec.claude_md
    ? path.resolve(projectDir, spec.claude_md)
    : undefined;

  // Validate extra_mounts against the allowlist
  const extra_mounts = resolveExtraMounts(spec.extra_mounts ?? []);

  const baseEnv: Record<string, string> = {
    TZ: TIMEZONE,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  };

  return {
    taskId: task.id,
    projectDir,
    workDir,
    hostWorkDir,
    ipcDir,
    suffix,
    containerName,
    isolation: spec.isolation ?? 'docker',
    image: spec.image ?? CONTAINER_IMAGE,
    timeout_ms: spec.timeout_ms ?? CONTAINER_TIMEOUT,
    model: spec.model,
    effort: spec.effort,
    max_turns: spec.max_turns,
    permission_mode: spec.permission_mode ?? 'bypassPermissions',
    max_budget_usd: spec.max_budget_usd,
    system_prompt: spec.system_prompt,
    append_system_prompt: spec.append_system_prompt,
    allowed_tools: spec.allowed_tools,
    disallowed_tools: spec.disallowed_tools,
    session_name: spec.session_name,
    no_session_persistence: spec.no_session_persistence ?? true,
    mcp_config_file,
    strict_mcp_config: spec.strict_mcp_config,
    settings_file,
    claude_md_path,
    extra_mounts,
    claude_binary: spec.claude_binary,
    env: { ...baseEnv, ...(spec.env ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// SessionBuilder — main public class
// ---------------------------------------------------------------------------

export class SessionBuilder {
  build(config: SessionConfig): SpawnSpec {
    const prompt =
      'Read /workspace/project/ipc/task.md and execute the task described. ' +
      'Write progress to /workspace/project/ipc/status.md as you work. ' +
      'When done, write a summary to /workspace/project/ipc/result.md.';

    switch (config.isolation) {
      case 'docker':
        return buildDockerSpawnSpec(config, prompt);
      case 'apple-container':
        return buildAppleContainerSpawnSpec(config, prompt);
      case 'local':
        if (!config.claude_binary) assertNativeHost(config.isolation);
        return buildLocalSpawnSpec(config, prompt);
      case 'worktree':
        if (!config.claude_binary) assertNativeHost(config.isolation);
        return buildLocalSpawnSpec(config, prompt); // identical mechanics; workDir is already the worktree
      default: {
        const _exhaustive: never = config.isolation;
        throw new Error(`Unknown isolation strategy: ${_exhaustive}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared: buildClaudeArgs — translates SessionConfig into claude CLI flags
// ---------------------------------------------------------------------------

function buildClaudeArgs(config: SessionConfig, prompt: string): string[] {
  const args: string[] = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
  ];

  if (config.model) args.push('--model', config.model);
  if (config.effort) args.push('--effort', config.effort);
  if (config.max_turns != null)
    args.push('--max-turns', String(config.max_turns));

  if (config.permission_mode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', config.permission_mode);
  }

  if (config.max_budget_usd != null)
    args.push('--max-budget-usd', String(config.max_budget_usd));
  if (config.system_prompt) args.push('--system-prompt', config.system_prompt);
  if (config.append_system_prompt)
    args.push('--append-system-prompt', config.append_system_prompt);
  if (config.allowed_tools?.length)
    args.push('--allowedTools', config.allowed_tools.join(','));
  if (config.disallowed_tools?.length)
    args.push('--disallowedTools', config.disallowed_tools.join(','));
  if (config.session_name) args.push('--name', config.session_name);
  if (config.no_session_persistence) args.push('--no-session-persistence');
  if (config.strict_mcp_config) args.push('--strict-mcp-config');

  // Prompt is always last
  args.push(prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Strategy: docker
// ---------------------------------------------------------------------------

function buildDockerSpawnSpec(
  config: SessionConfig,
  prompt: string,
): SpawnSpec {
  const args: string[] = ['run', '--rm', '--name', config.containerName];

  if (HARNESS_NETWORK) args.push('--network', HARNESS_NETWORK);

  args.push('-e', `TZ=${config.env.TZ ?? TIMEZONE}`);
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );
  args.push(...hostGatewayArgs());

  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Env vars from agent_spec (skip TZ since already set above)
  for (const [k, v] of Object.entries(config.env)) {
    if (k === 'TZ') continue;
    args.push('-e', `${k}=${v}`);
  }

  // Standard mounts
  args.push('-v', `${config.hostWorkDir}:/workspace/project`);
  args.push('-v', `${HOST_PKB_DIR}:/workspace/pkb:ro`);

  // Per-task isolated .claude/ session dir
  const sessionDir = ensureTaskSessionDir(config);
  args.push('-v', `${sessionDir}:/home/node/.claude`);

  // Optional settings.json override
  if (config.settings_file) {
    args.push(
      '-v',
      `${config.settings_file}:/home/node/.claude/settings.json:ro`,
    );
  }

  // Optional CLAUDE.md override
  if (config.claude_md_path) {
    args.push('-v', `${config.claude_md_path}:/workspace/project/CLAUDE.md:ro`);
  }

  // Extra mounts from agent_spec (already validated)
  for (const m of config.extra_mounts) {
    const roFlag = m.readonly ? ':ro' : '';
    args.push('-v', `${m.host}:${m.container}${roFlag}`);
  }

  args.push(config.image);

  // Translate mcp_config_file from orchestrator path to container path for --mcp-config
  const claudeArgs = buildClaudeArgs(config, prompt);
  if (config.mcp_config_file) {
    const containerPath = toContainerProjectPath(
      config.mcp_config_file,
      config.workDir,
    );
    claudeArgs.splice(
      claudeArgs.indexOf(prompt),
      0,
      '--mcp-config',
      containerPath,
    );
  }

  args.push(...claudeArgs);

  return {
    command: [CONTAINER_RUNTIME_BIN, ...args],
    env: process.env as Record<string, string>,
    workdir: config.projectDir,
    timeout_ms: config.timeout_ms,
    containerName: config.containerName,
  };
}

// ---------------------------------------------------------------------------
// Strategy: apple-container
// ---------------------------------------------------------------------------

function buildAppleContainerSpawnSpec(
  config: SessionConfig,
  prompt: string,
): SpawnSpec {
  const args: string[] = ['run', '--rm', '--name', config.containerName];

  args.push('-e', `TZ=${config.env.TZ ?? TIMEZONE}`);
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${APPLE_CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  for (const [k, v] of Object.entries(config.env)) {
    if (k === 'TZ') continue;
    args.push('-e', `${k}=${v}`);
  }

  args.push('-v', `${config.hostWorkDir}:/workspace/project`);
  args.push('-v', `${HOST_PKB_DIR}:/workspace/pkb:ro`);

  const sessionDir = ensureTaskSessionDir(config);
  args.push('-v', `${sessionDir}:/home/node/.claude`);

  if (config.settings_file) {
    args.push(
      '-v',
      `${config.settings_file}:/home/node/.claude/settings.json:ro`,
    );
  }
  if (config.claude_md_path) {
    args.push('-v', `${config.claude_md_path}:/workspace/project/CLAUDE.md:ro`);
  }
  for (const m of config.extra_mounts) {
    args.push('-v', `${m.host}:${m.container}${m.readonly ? ':ro' : ''}`);
  }

  args.push(config.image);

  const claudeArgs = buildClaudeArgs(config, prompt);
  if (config.mcp_config_file) {
    const containerPath = toContainerProjectPath(
      config.mcp_config_file,
      config.workDir,
    );
    claudeArgs.splice(
      claudeArgs.indexOf(prompt),
      0,
      '--mcp-config',
      containerPath,
    );
  }

  args.push(...claudeArgs);

  return {
    command: ['container', ...args],
    env: process.env as Record<string, string>,
    workdir: config.projectDir,
    timeout_ms: config.timeout_ms,
    containerName: config.containerName,
  };
}

// ---------------------------------------------------------------------------
// Strategy: local / worktree (claude runs directly on host)
// ---------------------------------------------------------------------------

function buildLocalSpawnSpec(config: SessionConfig, prompt: string): SpawnSpec {
  const claudeArgs = buildClaudeArgs(config, prompt);

  // Add --add-dir so claude can see the PKB (it's not in the workDir)
  claudeArgs.splice(claudeArgs.indexOf(prompt), 0, '--add-dir', PKB_DIR);

  // mcp_config_file is already on the host filesystem; pass directly
  if (config.mcp_config_file) {
    claudeArgs.splice(
      claudeArgs.indexOf(prompt),
      0,
      '--mcp-config',
      config.mcp_config_file,
    );
  }

  // For claude_md override: use --append-system-prompt if not already set,
  // or warn — there's no CLI flag to specify an alternate CLAUDE.md path.
  // The claude_md file needs to be in the workDir for Claude Code to pick it up.
  if (config.claude_md_path) {
    const targetClaudeMd = path.join(config.workDir, 'CLAUDE.md');
    if (config.claude_md_path !== targetClaudeMd) {
      logger.warn(
        {
          taskId: config.taskId,
          claude_md: config.claude_md_path,
          workDir: config.workDir,
        },
        'agent_spec.claude_md override for local isolation: copying to workDir/CLAUDE.md',
      );
      fs.copyFileSync(config.claude_md_path, targetClaudeMd);
    }
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...config.env,
  };

  return {
    command: [config.claude_binary ?? 'claude', ...claudeArgs],
    env,
    workdir: config.workDir,
    timeout_ms: config.timeout_ms,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate an orchestrator-side path inside workDir to its container-side
 * equivalent. The container always mounts workDir at /workspace/project.
 */
function toContainerProjectPath(
  orchestratorPath: string,
  workDir: string,
): string {
  const relative = path.relative(workDir, orchestratorPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Path ${orchestratorPath} is outside workDir ${workDir} — cannot translate to container path`,
    );
  }
  return `/workspace/project/${relative}`;
}

/**
 * Translate a container-side path to its host equivalent.
 * Same logic as toHostPath() in orchestrator.ts.
 */
function toHostPath(containerPath: string): string {
  if (HOST_PROJECTS_DIR === PROJECTS_DIR) return containerPath;
  const projectsParent = path.dirname(PROJECTS_DIR);
  const hostProjectsParent = path.dirname(HOST_PROJECTS_DIR);
  if (containerPath.startsWith(projectsParent + path.sep)) {
    return hostProjectsParent + containerPath.slice(projectsParent.length);
  }
  return containerPath;
}

/**
 * Create a per-task isolated .claude/ session directory.
 * This prevents cross-task session bleed when running with max_concurrent > 1.
 * Returns the host path (for use in docker -v flags).
 */
function ensureTaskSessionDir(config: SessionConfig): string {
  // Store the session dir inside the worktree so it lives on the host bind-mount.
  // The orchestrator creates it via the container path (config.workDir), but
  // returns the host path (config.hostWorkDir) for use in docker -v flags.
  // Using the worktree avoids the /app/data path which is inside a named volume
  // and therefore not accessible to sibling containers spawned by Docker Desktop.
  const claudeDir = path.join(config.workDir, '.claude-session');
  fs.mkdirSync(claudeDir, { recursive: true });

  // Write a minimal settings.json that disables auto-memory for sub-agents.
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } },
        null,
        2,
      ) + '\n',
    );
  }

  // Return the host path — this is what goes into the docker -v flag.
  return path.join(config.hostWorkDir, '.claude-session');
}

/**
 * Validate extra_mounts from agent_spec against the mount allowlist.
 * Container paths must be absolute and under /workspace/.
 */
function resolveExtraMounts(
  mounts: Array<{ host: string; container: string; readonly?: boolean }>,
): Array<{ host: string; container: string; readonly: boolean }> {
  const result: Array<{ host: string; container: string; readonly: boolean }> =
    [];

  for (const m of mounts) {
    // Container path validation
    if (!m.container.startsWith('/workspace/')) {
      logger.warn(
        { mount: m },
        'Extra mount rejected: container path must be under /workspace/',
      );
      continue;
    }
    if (m.container.includes('..')) {
      logger.warn(
        { mount: m },
        'Extra mount rejected: container path must not contain ".."',
      );
      continue;
    }

    // Host path validation via allowlist (use 'placeholder' as containerPath
    // since validateMount validates relative paths, but we handle container
    // paths ourselves above)
    const validation = validateMount(
      {
        hostPath: m.host,
        containerPath: 'placeholder',
        readonly: m.readonly ?? true,
      },
      true, // treat agent_spec mounts as main-group level
    );

    if (!validation.allowed) {
      logger.warn(
        { mount: m, reason: validation.reason },
        'Extra mount rejected by allowlist',
      );
      continue;
    }

    result.push({
      host: validation.realHostPath!,
      container: m.container,
      readonly: validation.effectiveReadonly ?? true,
    });
  }

  return result;
}

/**
 * Assert that the orchestrator is running natively on the host (not in Docker).
 * Local/worktree strategies require claude to be on PATH.
 */
function assertNativeHost(isolation: string): void {
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    throw new Error(
      `isolation="${isolation}" requires claude on PATH, but it was not found. ` +
        `This strategy only works when the orchestrator runs natively (not in Docker).`,
    );
  }
}
