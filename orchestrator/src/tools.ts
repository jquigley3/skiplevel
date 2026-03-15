/**
 * Tool API — lets authorized workers create and poll child tasks,
 * and provides host-facing endpoints for job submission and monitoring.
 *
 * Worker endpoints (Bearer token auth via job_token):
 *   POST /api/tasks      — spawn a child task (requires "spawn_task" tool)
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
import {
  createToken,
  getToken,
  getTokenByName,
  listTokens,
  deleteToken,
  CreateTokenInput,
  hasPermission,
  delegatePermission,
  getJobPermissions,
  getProjectPermissions,
  setProjectPermission,
  removeProjectPermission,
  listProjectPermissions,
  createPermissionRequest,
  getPermissionRequest,
  listPermissionRequests,
  approveRequest,
  denyRequest,
} from './permissions.js';
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

function hasTool(job: Job, tool: string): boolean {
  if (!job.mc2_tools) return false;
  try {
    const tools = JSON.parse(job.mc2_tools) as string[];
    return tools.includes(tool);
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
    exit_code: job.exit_code,
    worker_container: job.worker_container,
    retry_count: job.retry_count ?? 0,
    retry_after: job.retry_after,
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
  if (!hasTool(caller, 'spawn_task')) {
    json(res, 403, { error: 'Missing tool: spawn_task' });
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

  // Validate and delegate permissions (parent must have can_delegate for each token)
  const permInputs = body.permissions as Array<{ token_name: string; can_delegate?: boolean; duration_minutes?: number }> | undefined;
  if (permInputs && permInputs.length > 0) {
    const defaultDuration = 60;
    for (const p of permInputs) {
      const token = getTokenByName(p.token_name);
      if (!token) {
        json(res, 400, { error: `Unknown token: ${p.token_name}` });
        return;
      }
      const parentPerm = hasPermission(caller.id, token.id);
      if (!parentPerm) {
        json(res, 403, { error: `Parent lacks permission for token: ${p.token_name}` });
        return;
      }
      if (parentPerm.can_delegate !== 1) {
        json(res, 403, { error: `Parent cannot delegate token: ${p.token_name}` });
        return;
      }
    }
  }

  const id = createJob({
    prompt,
    project_dir: childProjectDir,
    model: (body.model as string) ?? undefined,
    max_turns: (body.max_turns as number) ?? undefined,
    max_budget_usd: (body.max_budget_usd as number) ?? undefined,
    system_prompt: (body.system_prompt as string) ?? undefined,
    append_system_prompt: (body.append_system_prompt as string) ?? undefined,
    permission_mode: (body.permission_mode as string) ?? undefined,
    mc2_tools: (body.tools as string[]) ?? undefined,
    allowed_paths: effectivePaths,
    parent_job_id: caller.id,
    priority: (body.priority as number) ?? undefined,
  });

  // Delegate permissions from parent to child
  if (permInputs && permInputs.length > 0) {
    const defaultDuration = 60;
    for (const p of permInputs) {
      const token = getTokenByName(p.token_name)!;
      try {
        delegatePermission(
          caller.id,
          id,
          token.id,
          p.can_delegate ?? false,
          p.duration_minutes ?? defaultDuration,
        );
      } catch (err) {
        logger.warn({ parentId: caller.id, childId: id, token: p.token_name, err }, 'Failed to delegate permission');
      }
    }
  }

  logger.info({ parentId: caller.id, childId: id }, 'Child task spawned via tool API');
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

function handleGetPermissions(res: ServerResponse, caller: Job): void {
  const perms = getJobPermissions(caller.id);
  json(res, 200, {
    permissions: perms.map((p) => ({
      id: p.id,
      token_name: p.token_name,
      can_delegate: p.can_delegate === 1,
      expires_at: p.expires_at,
    })),
  });
}

function permissionRequestSummary(req: { id: string; token_name: string; job_id: string; reason: string | null; duration_minutes: number; can_delegate: number; status: string; decided_at: string | null; decided_reason: string | null; created_at: string }): Record<string, unknown> {
  return {
    id: req.id,
    token_name: req.token_name,
    job_id: req.job_id,
    reason: req.reason,
    duration_minutes: req.duration_minutes,
    can_delegate: req.can_delegate === 1,
    status: req.status,
    decided_at: req.decided_at,
    decided_reason: req.decided_reason,
    created_at: req.created_at,
  };
}

async function handlePermissionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Job,
): Promise<void> {
  const url = req.url ?? '';
  const requestIdMatch = url.match(/^\/api\/permissions\/request\/([^/?]+)/);

  if (url === '/api/permissions/request' || url === '/api/permissions/request/') {
    if (req.method === 'POST') {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const tokenName = body.token_name as string | undefined;
      const reason = body.reason as string | undefined;
      const durationMinutes = (body.duration_minutes as number) ?? 30;
      const canDelegate = (body.can_delegate as boolean) ?? false;
      const wait = (body.wait as boolean) ?? false;
      const waitTimeoutSeconds = Math.min((body.wait_timeout_seconds as number) ?? 300, 600);

      if (!tokenName) {
        json(res, 400, { error: 'Missing required field: token_name' });
        return;
      }

      let requestId: string;
      try {
        requestId = createPermissionRequest({
          tokenName,
          jobId: caller.id,
          reason,
          durationMinutes,
          canDelegate,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, 400, { error: msg });
        return;
      }

      if (!wait) {
        const pr = getPermissionRequest(requestId)!;
        json(res, 201, {
          status: 'pending',
          request_id: requestId,
          message: 'Request is pending human approval. Poll GET /api/permissions/request/<id> or retry with wait.',
        });
        return;
      }

      // Long-poll: check periodically until decided or timeout
      const start = Date.now();
      const pollIntervalMs = 500;
      while (Date.now() - start < waitTimeoutSeconds * 1000) {
        const pr = getPermissionRequest(requestId);
        if (!pr) {
          json(res, 404, { error: 'Request not found' });
          return;
        }
        if (pr.status === 'approved') {
          const perms = getJobPermissions(caller.id);
          const match = perms.find((p) => p.token_name === pr.token_name);
          json(res, 200, {
            status: 'approved',
            permission_id: match?.id ?? 'created',
            expires_at: match?.expires_at ?? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString(),
          });
          return;
        }
        if (pr.status === 'denied') {
          json(res, 200, { status: 'denied', reason: pr.decided_reason ?? 'Denied' });
          return;
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      json(res, 200, {
        status: 'pending',
        request_id: requestId,
        message: 'Request is pending human approval. Poll GET /api/permissions/request/<id> or retry with wait.',
      });
    } else {
      json(res, 405, { error: 'Method not allowed' });
    }
    return;
  }

  if (requestIdMatch && req.method === 'GET') {
    const requestId = requestIdMatch[1];
    const pr = getPermissionRequest(requestId);
    if (!pr || pr.job_id !== caller.id) {
      json(res, 404, { error: 'Request not found' });
      return;
    }
    if (pr.status === 'approved') {
      const perms = getJobPermissions(caller.id);
      const match = perms.find((p) => p.token_name === pr.token_name);
      json(res, 200, {
        ...permissionRequestSummary(pr),
        permission_id: match?.id,
        expires_at: match?.expires_at,
      });
    } else if (pr.status === 'denied') {
      json(res, 200, { ...permissionRequestSummary(pr), reason: pr.decided_reason });
    } else {
      json(res, 200, permissionRequestSummary(pr));
    }
    return;
  }

  json(res, 404, { error: 'Unknown endpoint' });
}

// ---------------------------------------------------------------------------
// Token registry (/api/tokens) — host-facing, no auth
// ---------------------------------------------------------------------------

function tokenSummary(token: { id: string; name: string; url_pattern: string; description: string | null; project_dir: string | null; created_at: string }): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    url_pattern: token.url_pattern,
    description: token.description,
    project_dir: token.project_dir,
    created_at: token.created_at,
  };
}

async function handleTokensRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '';
  const tokenIdMatch = url.match(/^\/api\/tokens\/([^/?]+)/);

  if (url === '/api/tokens' || url === '/api/tokens/') {
    if (req.method === 'GET') {
      const parsed = new URL(url, 'http://localhost');
      const projectDir = parsed.searchParams.get('project_dir') ?? undefined;
      const tokens = listTokens(projectDir);
      json(res, 200, { tokens: tokens.map((t) => tokenSummary(t)) });
    } else if (req.method === 'POST') {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      const name = body.name as string | undefined;
      const urlPattern = body.url_pattern as string | undefined;
      const injectHeader = body.inject_header as string | undefined;
      const injectValue = body.inject_value as string | undefined;
      if (!name || !urlPattern || !injectHeader || !injectValue) {
        json(res, 400, { error: 'Missing required fields: name, url_pattern, inject_header, inject_value' });
        return true;
      }
      try {
        const id = createToken({
          name,
          url_pattern: urlPattern,
          inject_header: injectHeader,
          inject_value: injectValue,
          description: body.description as string | undefined,
          project_dir: body.project_dir as string | undefined,
        } as CreateTokenInput);
        logger.info({ tokenId: id, name }, 'Token registered');
        json(res, 201, { id, name, status: 'created' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('UNIQUE constraint')) {
          json(res, 409, { error: `Token with name '${name}' already exists` });
        } else {
          logger.error({ err }, 'Token creation error');
          json(res, 500, { error: 'Failed to create token' });
        }
      }
    } else {
      json(res, 405, { error: 'Method not allowed' });
    }
    return true;
  }

  if (tokenIdMatch && req.method === 'DELETE') {
    const idOrName = tokenIdMatch[1];
    const existing = getToken(idOrName) ?? getTokenByName(idOrName);
    if (!existing) {
      json(res, 404, { error: 'Token not found' });
      return true;
    }
    deleteToken(idOrName);
    logger.info({ tokenId: existing.id, name: existing.name }, 'Token removed');
    json(res, 200, { id: existing.id, status: 'deleted' });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Project permissions (/api/project-permissions) — host-facing, no auth
// ---------------------------------------------------------------------------

async function handleProjectPermissionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '';
  const ppIdMatch = url.match(/^\/api\/project-permissions\/([^/?]+)/);

  if (url === '/api/project-permissions' || url === '/api/project-permissions/') {
    if (req.method === 'GET') {
      const projectPerms = listProjectPermissions();
      json(res, 200, {
        project_permissions: projectPerms.map((pp) => ({
          id: pp.id,
          project_dir: pp.project_dir,
          token_id: pp.token_id,
          can_delegate: pp.can_delegate === 1,
          duration_minutes: pp.duration_minutes,
        })),
      });
    } else if (req.method === 'POST') {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      const projectDir = body.project_dir as string | undefined;
      const tokenId = body.token_id as string | undefined;
      const canDelegate = body.can_delegate as boolean | undefined;
      const durationMinutes = body.duration_minutes as number | undefined;
      if (!projectDir || !tokenId || durationMinutes == null) {
        json(res, 400, { error: 'Missing required fields: project_dir, token_id, duration_minutes' });
        return true;
      }
      const token = getToken(tokenId);
      if (!token) {
        json(res, 400, { error: 'Token not found' });
        return true;
      }
      const id = setProjectPermission({
        projectDir,
        tokenId,
        canDelegate: canDelegate ?? false,
        durationMinutes,
      });
      logger.info({ id, projectDir, tokenId }, 'Project permission added');
      json(res, 201, { id, status: 'created' });
    } else {
      json(res, 405, { error: 'Method not allowed' });
    }
    return true;
  }

  if (ppIdMatch && req.method === 'DELETE') {
    const id = ppIdMatch[1];
    removeProjectPermission(id);
    logger.info({ id }, 'Project permission removed');
    json(res, 200, { id, status: 'deleted' });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Permission requests (/api/permissions/requests) — host-facing, no auth
// ---------------------------------------------------------------------------

async function handlePermissionRequestsRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '';
  const approveMatch = url.match(/^\/api\/permissions\/requests\/([^/]+)\/approve\/?$/);
  const denyMatch = url.match(/^\/api\/permissions\/requests\/([^/]+)\/deny\/?$/);

  if (url === '/api/permissions/requests' || url === '/api/permissions/requests/') {
    if (req.method === 'GET') {
      const parsed = new URL(url, 'http://localhost');
      const status = parsed.searchParams.get('status') as 'pending' | 'approved' | 'denied' | undefined;
      const requests = listPermissionRequests(status);
      json(res, 200, { requests: requests.map(permissionRequestSummary) });
    } else {
      json(res, 405, { error: 'Method not allowed' });
    }
    return true;
  }

  if (approveMatch && req.method === 'POST') {
    const requestId = approveMatch[1];
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch { /* optional body */ }
    }
    const durationMinutes = body.duration_minutes as number | undefined;
    try {
      const permId = approveRequest(requestId, durationMinutes);
      json(res, 200, { status: 'approved', permission_id: permId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 400, { error: msg });
    }
    return true;
  }

  if (denyMatch && req.method === 'POST') {
    const requestId = denyMatch[1];
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch { /* optional body */ }
    }
    const reason = body.reason as string | undefined;
    try {
      denyRequest(requestId, reason);
      json(res, 200, { status: 'denied' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 400, { error: msg });
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Host-facing endpoints (/api/jobs) — no auth, trusted callers
// ---------------------------------------------------------------------------

interface JobDetailOptions {
  includeTranscript?: boolean;
}

function jobDetail(job: Job, opts: JobDetailOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    project_dir: job.project_dir,
    model: job.model,
    tools: job.mc2_tools ? JSON.parse(job.mc2_tools) : null,
    allowed_paths: job.allowed_paths ? JSON.parse(job.allowed_paths) : null,
    parent_job_id: job.parent_job_id,
    result_text: job.result_text,
    error: job.error,
    cost_usd: job.cost_usd,
    duration_ms: job.duration_ms,
    exit_code: job.exit_code,
    worker_container: job.worker_container,
    retry_count: job.retry_count ?? 0,
    retry_after: job.retry_after,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
  if (opts.includeTranscript && job.transcript) {
    out.transcript = job.transcript;
  }
  return out;
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
    mc2_tools: (body.tools as string[]) ?? undefined,
    allowed_paths: (body.allowed_paths as string[]) ?? undefined,
    priority: (body.priority as number) ?? undefined,
    permissions: (body.permissions as Array<{ token_name: string; can_delegate?: boolean; duration_minutes?: number }>) ?? undefined,
  });

  logger.info({ jobId: id }, 'Job submitted via API');
  json(res, 201, { id, status: 'pending' });
}

function handleGetJob(req: IncomingMessage, res: ServerResponse, jobId: string): void {
  const job = getJob(jobId);
  if (!job) {
    json(res, 404, { error: 'Job not found' });
    return;
  }
  const parsed = new URL(req.url ?? '', 'http://localhost');
  const include = parsed.searchParams.get('include');
  const includeTranscript = include?.split(',').includes('transcript') ?? false;
  json(res, 200, jobDetail(job, { includeTranscript }));
}

function handleListJobs(req: IncomingMessage, res: ServerResponse): void {
  const parsed = new URL(req.url ?? '', 'http://localhost');
  const status = parsed.searchParams.get('status') ?? undefined;
  const limit = parseInt(parsed.searchParams.get('limit') ?? '50', 10);
  const jobs = listJobs(status, limit);
  json(res, 200, { jobs: jobs.map((j) => jobDetail(j)) });
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
      handleGetJob(req, res, jobId);
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
export async function handleToolRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '';

  if (!url.startsWith('/api/')) return false;

  // Host-facing /api/jobs endpoints — no auth required
  if (url.startsWith('/api/jobs')) {
    return handleJobsRoute(req, res);
  }

  // Host-facing /api/tokens — no auth required
  if (url.startsWith('/api/tokens')) {
    return handleTokensRoute(req, res);
  }

  // Host-facing /api/project-permissions — no auth required
  if (url.startsWith('/api/project-permissions')) {
    return handleProjectPermissionsRoute(req, res);
  }

  // Host-facing /api/permissions/requests — list, approve, deny
  if (url.startsWith('/api/permissions/requests')) {
    return handlePermissionRequestsRoute(req, res);
  }

  // Worker endpoints below require Bearer token auth
  const caller = authenticate(req);
  if (!caller) {
    json(res, 401, { error: 'Unauthorized — invalid or missing Bearer token' });
    return true;
  }

  const taskIdMatch = url.match(/^\/api\/tasks\/([^/?]+)/);

  if (url === '/api/permissions' || url === '/api/permissions/') {
    if (req.method === 'GET') {
      handleGetPermissions(res, caller);
    } else {
      json(res, 405, { error: 'Method not allowed' });
    }
    return true;
  }

  if (url.startsWith('/api/permissions/request')) {
    await handlePermissionRequest(req, res, caller);
    return true;
  }

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
