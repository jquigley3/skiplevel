# 04 — Worker Container Spawning and Transcript Capture

## Overview

The worker module adapts nano-claw's `container-runner.ts`. The core pattern is the same:

1. Build Docker `run` args with bind mounts and env vars
2. Spawn the container as a child process
3. Parse `stdout` as stream-json (one JSON event per line)
4. Capture the full transcript + extract the final result text
5. Return everything to the orchestrator

The key difference from nano-claw: we return the transcript as a string (not via IPC files), and the working directory is a git worktree (not a group folder).

## src/worker.ts

```typescript
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

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
  workDir: string; // Path the orchestrator sees (container or host)
  hostWorkDir: string; // Path on the Docker host (for -v flags)
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
  resultText: string | null; // Final response from Claude
  transcript: string; // Full JSONL stream
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
    '--output-format',
    'stream-json',
  ];

  if (input.model) args.push('--model', input.model);
  if (input.maxTurns) args.push('--max-turns', String(input.maxTurns));
  if (input.maxBudgetUsd)
    args.push('--max-budget-usd', String(input.maxBudgetUsd));

  if (input.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', input.permissionMode);
  }

  if (input.systemPrompt) args.push('--system-prompt', input.systemPrompt);
  if (input.appendSystemPrompt)
    args.push('--append-system-prompt', input.appendSystemPrompt);
  if (input.allowedTools?.length)
    args.push('--allowedTools', input.allowedTools.join(','));
  if (input.disallowedTools?.length)
    args.push('--disallowedTools', input.disallowedTools.join(','));

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

  // Timezone
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

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
    JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }, null, 2) +
      '\n',
  );
  const hostSessionDir = path.join(input.hostWorkDir, '.claude-session');
  args.push('-v', `${hostSessionDir}:/home/node/.claude`);

  // Docker network (if configured)
  const network = process.env.HARNESS_NETWORK;
  if (network) args.push('--network', network);

  // Image
  args.push(CONTAINER_IMAGE);

  // Claude CLI args
  args.push(...buildClaudeArgs(input));

  return args;
}

// ---------------------------------------------------------------------------
// Run worker
// ---------------------------------------------------------------------------

export function runWorker(input: WorkerInput): Promise<WorkerResult> {
  const containerName = `macro-claw-${input.jobId.slice(0, 8)}-${input.suffix}`;

  const dockerArgs = buildDockerArgs(input, containerName);

  logger.info(
    { jobId: input.jobId, containerName, model: input.model },
    'Spawning worker container',
  );

  return new Promise((resolve) => {
    const startTime = Date.now();
    const container = spawn(CONTAINER_RUNTIME_BIN, dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    const transcriptLines: string[] = [];
    let resultText: string | null = null;
    let costUsd: number | null = null;

    // Parse stream-json events from stdout
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

          // Log key events for visibility
          if (event.type === 'system' && event.subtype === 'init') {
            logger.debug(
              { jobId: input.jobId, model: event.model },
              'Worker session started',
            );
          } else if (event.type === 'assistant') {
            const content = (event.message as Record<string, unknown>)
              ?.content as Array<Record<string, unknown>>;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text') {
                  const text = (block.text as string).trim();
                  for (const textLine of text.split('\n')) {
                    if (textLine.trim())
                      process.stdout.write(
                        `[${input.jobId.slice(0, 8)}] ${textLine}\n`,
                      );
                  }
                } else if (block.type === 'tool_use') {
                  const snippet = JSON.stringify(block.input).slice(0, 200);
                  process.stdout.write(
                    `[${input.jobId.slice(0, 8)}] [tool:${block.name}] ${snippet}\n`,
                  );
                }
              }
            }
          } else if (event.type === 'result') {
            const cost = costUsd != null ? `$${costUsd.toFixed(4)}` : '?';
            process.stdout.write(
              `[${input.jobId.slice(0, 8)}] [done] cost=${cost} error=${event.is_error}\n`,
            );
          }
        } catch {
          // Non-JSON line (e.g., entrypoint output)
          process.stdout.write(`[${input.jobId.slice(0, 8)}] ${trimmed}\n`);
        }
      }
    });

    container.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.trim().split('\n')) {
        if (line)
          process.stderr.write(`[${input.jobId.slice(0, 8)}] ${line}\n`);
      }
    });

    // Timeout
    const timeout = setTimeout(() => {
      logger.error({ jobId: input.jobId, containerName }, 'Worker timeout');
      try {
        const { execSync } = require('child_process');
        execSync(`${CONTAINER_RUNTIME_BIN} stop ${containerName}`, {
          timeout: 15000,
        });
      } catch {
        container.kill('SIGTERM');
      }
    }, CONTAINER_TIMEOUT);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;
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
```

## Transcript Format

The `transcript` field in the result is a JSONL string (one JSON object per line). Each line is a Claude Code stream-json event. Key event types:

```jsonl
{"type":"system","subtype":"init","session_id":"...","model":"claude-sonnet-4-5"}
{"type":"assistant","message":{"content":[{"type":"text","text":"I'll help you..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/workspace/project/src/main.ts"}}]}}
{"type":"tool_result","content":[{"type":"text","text":"file contents..."}]}
{"type":"assistant","message":{"content":[{"type":"text","text":"Here's what I found..."}]}}
{"type":"result","result":"Final answer text","total_cost_usd":0.0234,"is_error":false}
```

The caller can parse this to extract:

- **Reasoning**: all `assistant` events with `text` blocks
- **Tool usage**: all `assistant` events with `tool_use` blocks + their `tool_result` responses
- **Final answer**: the `result` event's `result` field (also stored as `result_text` in the DB for convenience)
- **Cost**: the `result` event's `total_cost_usd`

## What Gets Returned (Not Shared Workspace)

The transcript and result_text are returned in the SQLite row, not written to the project workspace. The worktree contains the agent's file changes (code, etc.) but the transcript lives only in the database. This keeps the workspace clean and avoids conflicts.

Think of it as:

- **Worktree** = "what the agent built" (files, code changes, commits)
- **Transcript** = "what the agent said and thought" (reasoning, tool calls, final answer)
- **result_text** = "the final response" (just the answer, no reasoning)
