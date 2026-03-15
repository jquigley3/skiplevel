/**
 * Capability API — lets authorized workers create and poll child tasks,
 * and provides host-facing endpoints for job submission and monitoring.
 *
 * Worker endpoints (Bearer token auth via job_token):
 *   POST /api/tasks      — spawn a child task (requires "spawn_task" capability)
 *   GET  /api/tasks/:id  — get status/result of own child
 *   GET  /api/tasks      — list own children
 *
 * Host endpoints (no auth — trusted callers on localhost):
 *   POST /api/jobs       — submit a new job
 *   GET  /api/jobs       — list jobs (optional ?status= filter)
 *   GET  /api/jobs/:id   — get job status/result
 */
import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';

import {
  getJobByToken,
  getJob,
  createJob,
  listJobs,
  listChildJobs,
  Job,
} from './db.js';
import { logger } from './logger.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function authenticate(req: IncomingMessage): Job | null {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return getJobByToken(token) ?? null;
}

function hasCapability(job: Job, cap: string): boolean {
  if (!job.capabilities) return false;
  try {
    const caps = JSON.parse(job.capabilities) as string[];
    return caps.includes(cap);
  } catch {
    return false;
  }
}

function parseAllowedPaths(job: Job): string[] {
  if (!job.allowed_paths) return [];
  try {
    return JSON.parse(job.allowed_paths) as string[];
  } catch {
    return [];
  }
}

function isPathAllowed(path: string, allowedPaths: string[]): boolean {
  return allowedPaths.some(
    (allowed) => path === allowed || path.startsWith(allowed + '/'),
  );
}

function jobSummary(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    result_text: job.result_text,
    error: job.error,
    cost_usd: job.cost_usd,
    duration_ms: job.duration_ms,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

async function handleCreateTask(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Job,
): Promise<void> {
  if (!hasCapability(caller, 'spawn_task')) {
    json(res, 403, { error: 'Missing capability: spawn_task' });
    return;
  }

  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const prompt = body.prompt as string | undefined;
  if (!prompt) {
    json(res, 400, { error: 'Missing required field: prompt' });
    return;
  }

  const parentPaths = parseAllowedPaths(caller);

  // Validate child's project_dir against parent's allowed_paths
  const childProjectDir = (body.project_dir as string) || caller.project_dir;
  if (parentPaths.length > 0 && !isPathAllowed(childProjectDir, parentPaths)) {
    json(res, 403, {
      error: `project_dir "${childProjectDir}" is not in parent's allowed_paths`,
    });
    return;
  }

  // Validate child's allowed_paths are a subset of parent's
  const childPaths = (body.allowed_paths as string[]) ?? undefined;
  if (childPaths && parentPaths.length > 0) {
    const disallowed = childPaths.filter((p) => !isPathAllowed(p, parentPaths));
    if (disallowed.length > 0) {
      json(res, 403, {
        error: `allowed_paths not permitted by parent: ${disallowed.join(', ')}`,
      });
      return;
    }
  }

  // Inherit parent's allowed_paths if child doesn't specify
  const effectivePaths = childPaths ?? (parentPaths.length > 0 ? parentPaths : undefined);

  const id = createJob({
    prompt,
    project_dir: childProjectDir,
    model: (body.model as string) ?? undefined,
    max_turns: (body.max_turns as number) ?? undefined,
    max_budget_usd: (body.max_budget_usd as number) ?? undefined,
    system_prompt: (body.system_prompt as string) ?? undefined,
    append_system_prompt: (body.append_system_prompt as string) ?? undefined,
    permission_mode: (body.permission_mode as string) ?? undefined,
    capabilities: (body.capabilities as string[]) ?? undefined,
    allowed_paths: effectivePaths,
    parent_job_id: caller.id,
    priority: (body.priority as number) ?? undefined,
  });

  logger.info({ parentId: caller.id, childId: id }, 'Child task spawned via capability API');
  json(res, 201, { id, status: 'pending' });
}

function handleGetTask(
  res: ServerResponse,
  caller: Job,
  taskId: string,
): void {
  const child = getJob(taskId);
  if (!child || child.parent_job_id !== caller.id) {
    json(res, 404, { error: 'Task not found' });
    return;
  }
  json(res, 200, jobSummary(child));
}

function handleListTasks(
  res: ServerResponse,
  caller: Job,
): void {
  const children = listChildJobs(caller.id);
  json(res, 200, { tasks: children.map(jobSummary) });
}

// ---------------------------------------------------------------------------
// Host-facing endpoints (/api/jobs) — no auth, trusted callers
// ---------------------------------------------------------------------------

function jobDetail(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    project_dir: job.project_dir,
    model: job.model,
    capabilities: job.capabilities ? JSON.parse(job.capabilities) : null,
    allowed_paths: job.allowed_paths ? JSON.parse(job.allowed_paths) : null,
    parent_job_id: job.parent_job_id,
    result_text: job.result_text,
    error: job.error,
    cost_usd: job.cost_usd,
    duration_ms: job.duration_ms,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

async function handleSubmitJob(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const prompt = body.prompt as string | undefined;
  const projectDir = body.project_dir as string | undefined;
  if (!prompt || !projectDir) {
    json(res, 400, { error: 'Missing required fields: prompt, project_dir' });
    return;
  }

  const id = createJob({
    prompt,
    project_dir: projectDir,
    model: (body.model as string) ?? undefined,
    max_turns: (body.max_turns as number) ?? undefined,
    max_budget_usd: (body.max_budget_usd as number) ?? undefined,
    system_prompt: (body.system_prompt as string) ?? undefined,
    append_system_prompt: (body.append_system_prompt as string) ?? undefined,
    permission_mode: (body.permission_mode as string) ?? undefined,
    capabilities: (body.capabilities as string[]) ?? undefined,
    allowed_paths: (body.allowed_paths as string[]) ?? undefined,
    priority: (body.priority as number) ?? undefined,
  });

  logger.info({ jobId: id }, 'Job submitted via API');
  json(res, 201, { id, status: 'pending' });
}

function handleGetJob(res: ServerResponse, jobId: string): void {
  const job = getJob(jobId);
  if (!job) {
    json(res, 404, { error: 'Job not found' });
    return;
  }
  json(res, 200, jobDetail(job));
}

function handleListJobs(req: IncomingMessage, res: ServerResponse): void {
  const parsed = new URL(req.url ?? '', 'http://localhost');
  const status = parsed.searchParams.get('status') ?? undefined;
  const limit = parseInt(parsed.searchParams.get('limit') ?? '50', 10);
  const jobs = listJobs(status, limit);
  json(res, 200, { jobs: jobs.map(jobDetail) });
}

async function handleJobsRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '';

  const jobIdMatch = url.match(/^\/api\/jobs\/([^/?]+)/);

  if (url.startsWith('/api/jobs') && !jobIdMatch) {
    if (req.method === 'POST') {
      await handleSubmitJob(req, res);
    } else if (req.method === 'GET') {
      handleListJobs(req, res);
    } else {
      json(res, 405, { error: 'Method not allowed' });
    }
    return true;
  }

  if (jobIdMatch) {
    const jobId = jobIdMatch[1];
    if (req.method === 'GET') {
      handleGetJob(res, jobId);
    } else {
      json(res, 405, { error: 'Method not allowed' });
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

/**
 * Handle an incoming HTTP request to /api/*.
 * Returns true if the request was handled, false if the path didn't match.
 */
export async function handleCapabilityRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '';

  if (!url.startsWith('/api/')) return false;

  // Host-facing /api/jobs endpoints — no auth required
  if (url.startsWith('/api/jobs')) {
    return handleJobsRoute(req, res);
  }

  // Worker endpoints below require Bearer token auth
  const caller = authenticate(req);
  if (!caller) {
    json(res, 401, { error: 'Unauthorized — invalid or missing Bearer token' });
    return true;
  }

  const taskIdMatch = url.match(/^\/api\/tasks\/([^/?]+)/);

  if (url === '/api/tasks' || url === '/api/tasks/') {
    if (req.method === 'POST') {
      await handleCreateTask(req, res, caller);
    } else if (req.method === 'GET') {
      handleListTasks(res, caller);
    } else {
      json(res, 405, { error: 'Method not allowed' });
    }
    return true;
  }

  if (taskIdMatch) {
    const taskId = taskIdMatch[1];
    if (req.method === 'GET') {
      handleGetTask(res, caller, taskId);
    } else {
      json(res, 405, { error: 'Method not allowed' });
    }
    return true;
  }

  json(res, 404, { error: 'Unknown API endpoint' });
  return true;
}
