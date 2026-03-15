import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';

import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  TIMEZONE,
} from './config.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerInput {
  jobId: string;
  suffix: string;
  prompt: string;
  workDir: string;        // Path the orchestrator sees (container or host)
  hostWorkDir: string;    // Path on the Docker host (for -v flags)
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissionMode: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  extraEnv?: Record<string, string>;
}

export interface WorkerResult {
  status: 'success' | 'error';
  exitCode: number;
  resultText: string | null;
  transcript: string;
  costUsd: number | null;
  containerName: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Build Claude CLI arguments
// ---------------------------------------------------------------------------

function buildClaudeArgs(input: WorkerInput): string[] {
  const args: string[] = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
  ];

  if (input.model)        args.push('--model', input.model);
  if (input.maxTurns)     args.push('--max-turns', String(input.maxTurns));
  if (input.maxBudgetUsd) args.push('--max-budget-usd', String(input.maxBudgetUsd));

  if (input.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', input.permissionMode);
  }

  if (input.systemPrompt)       args.push('--system-prompt', input.systemPrompt);
  if (input.appendSystemPrompt) args.push('--append-system-prompt', input.appendSystemPrompt);
  if (input.allowedTools?.length)    args.push('--allowedTools', input.allowedTools.join(','));
  if (input.disallowedTools?.length) args.push('--disallowedTools', input.disallowedTools.join(','));

  args.push('--no-session-persistence');

  // Prompt is always last
  args.push(input.prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Build Docker container args
// ---------------------------------------------------------------------------

function buildDockerArgs(input: WorkerInput, containerName: string): string[] {
  const args: string[] = ['run', '--rm', '--name', containerName];

  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy
  // When on a Docker network, connect directly to orchestrator by name
  // Otherwise use host gateway (for host-local mode)
  const harnessNetwork = process.env.HARNESS_NETWORK;
  const proxyUrl = harnessNetwork
    ? `http://macro-claw-orchestrator:${CREDENTIAL_PROXY_PORT}`
    : `http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`;
  args.push('-e', `ANTHROPIC_BASE_URL=${proxyUrl}`);

  // Auth placeholder — credential proxy replaces with real credentials
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Host gateway resolution (needed on Linux)
  args.push(...hostGatewayArgs());

  // Env vars from job spec
  const env: Record<string, string> = {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    ...(input.extraEnv ?? {}),
  };
  for (const [k, v] of Object.entries(env)) {
    args.push('-e', `${k}=${v}`);
  }

  // Mount the worktree as /workspace/project
  args.push('-v', `${input.hostWorkDir}:/workspace/project`);

  // Per-job isolated .claude/ session directory
  const sessionDir = path.join(input.workDir, '.claude-session');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'settings.json'),
    JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }, null, 2) + '\n',
  );
  const hostSessionDir = path.join(input.hostWorkDir, '.claude-session');
  args.push('-v', `${hostSessionDir}:/home/node/.claude`);

  // Docker network (if configured)
  const network = process.env.HARNESS_NETWORK;
  if (network) args.push('--network', network);

  // Image
  args.push(CONTAINER_IMAGE);

  // Claude CLI args (support binary override for testing)
  const claudeBin = process.env.CLAUDE_BINARY;
  if (claudeBin) {
    // Local non-Docker mode: run the binary directly, skip docker
    return [];
  }

  args.push(...buildClaudeArgs(input));

  return args;
}

// ---------------------------------------------------------------------------
// Run worker
// ---------------------------------------------------------------------------

export function runWorker(input: WorkerInput): Promise<WorkerResult> {
  const containerName = `macro-claw-${input.jobId.slice(0, 8)}-${input.suffix}`;

  // Support CLAUDE_BINARY override for local testing without Docker
  const claudeBin = process.env.CLAUDE_BINARY;
  let bin: string;
  let args: string[];

  if (claudeBin) {
    bin = claudeBin;
    args = buildClaudeArgs(input);
    logger.info({ jobId: input.jobId, bin }, 'Spawning worker (local mode, no Docker)');
  } else {
    bin = CONTAINER_RUNTIME_BIN;
    args = buildDockerArgs(input, containerName);
    logger.info({ jobId: input.jobId, containerName, model: input.model }, 'Spawning worker container');
  }

  return new Promise((resolve) => {
    const container = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    const transcriptLines: string[] = [];
    let resultText: string | null = null;
    let costUsd: number | null = null;

    let lineBuffer = '';

    container.stdout.on('data', (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        transcriptLines.push(trimmed);

        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;

          if (event.type === 'result') {
            resultText = (event.result as string) ?? null;
            costUsd = (event.total_cost_usd as number) ?? null;
          }

          if (event.type === 'system' && event.subtype === 'init') {
            logger.debug({ jobId: input.jobId, model: event.model }, 'Worker session started');
          } else if (event.type === 'assistant') {
            const content = (event.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text') {
                  const text = (block.text as string).trim();
                  for (const textLine of text.split('\n')) {
                    if (textLine.trim()) process.stdout.write(`[${input.jobId.slice(0, 8)}] ${textLine}\n`);
                  }
                } else if (block.type === 'tool_use') {
                  const snippet = JSON.stringify(block.input).slice(0, 200);
                  process.stdout.write(`[${input.jobId.slice(0, 8)}] [tool:${block.name}] ${snippet}\n`);
                }
              }
            }
          } else if (event.type === 'result') {
            const cost = costUsd != null ? `$${costUsd.toFixed(4)}` : '?';
            process.stdout.write(`[${input.jobId.slice(0, 8)}] [done] cost=${cost} error=${event.is_error}\n`);
          }
        } catch {
          process.stdout.write(`[${input.jobId.slice(0, 8)}] ${trimmed}\n`);
        }
      }
    });

    container.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.trim().split('\n')) {
        if (line) process.stderr.write(`[${input.jobId.slice(0, 8)}] ${line}\n`);
      }
    });

    const timeout = setTimeout(() => {
      logger.error({ jobId: input.jobId, containerName }, 'Worker timeout');
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} stop ${containerName}`, { timeout: 15000 });
      } catch {
        container.kill('SIGTERM');
      }
    }, CONTAINER_TIMEOUT);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const transcript = transcriptLines.join('\n');
      const exitCode = code ?? 1;

      if (exitCode === 0) {
        resolve({
          status: 'success',
          exitCode,
          resultText,
          transcript,
          costUsd,
          containerName,
        });
      } else {
        resolve({
          status: 'error',
          exitCode,
          resultText,
          transcript,
          costUsd,
          containerName,
          error: `Exit code ${exitCode}: ${stderr.slice(-500)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        status: 'error',
        exitCode: 1,
        resultText: null,
        transcript: transcriptLines.join('\n'),
        costUsd: null,
        containerName,
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}
