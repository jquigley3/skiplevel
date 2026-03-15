/**
 * Scoped token permissions — token registry and permission logic.
 * Tokens are stored in DB; proxy injects them into outbound requests.
 */
import crypto from 'crypto';
import { getDb } from './db.js';

export interface Token {
  id: string;
  name: string;
  url_pattern: string;
  inject_header: string;
  inject_value: string;
  description: string | null;
  project_dir: string | null;
  created_at: string;
}

export interface CreateTokenInput {
  name: string;
  url_pattern: string;
  inject_header: string;
  inject_value: string;
  description?: string;
  project_dir?: string;
}

/** Register a new token. Returns token ID. */
export function createToken(input: CreateTokenInput): string {
  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO tokens (id, name, url_pattern, inject_header, inject_value, description, project_dir)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.url_pattern,
    input.inject_header,
    input.inject_value,
    input.description ?? null,
    input.project_dir ?? null,
  );
  return id;
}

/** Get a token by ID. */
export function getToken(id: string): Token | undefined {
  return getDb().prepare('SELECT * FROM tokens WHERE id = ?').get(id) as Token | undefined;
}

/** Get a token by name. */
export function getTokenByName(name: string): Token | undefined {
  return getDb().prepare('SELECT * FROM tokens WHERE name = ?').get(name) as Token | undefined;
}

/** List tokens. If projectDir is provided, only tokens visible to that project. */
export function listTokens(projectDir?: string): Token[] {
  const db = getDb();
  if (projectDir) {
    return db.prepare(`
      SELECT * FROM tokens
      WHERE project_dir IS NULL OR ? LIKE project_dir || '%'
      ORDER BY name ASC
    `).all(projectDir) as Token[];
  }
  return db.prepare('SELECT * FROM tokens ORDER BY name ASC').all() as Token[];
}

/** Remove a token by ID or name. */
export function deleteToken(idOrName: string): void {
  const db = getDb();
  const byId = db.prepare('DELETE FROM tokens WHERE id = ?').run(idOrName);
  if (byId.changes === 0) {
    db.prepare('DELETE FROM tokens WHERE name = ?').run(idOrName);
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface Permission {
  id: string;
  token_id: string;
  job_id: string;
  can_delegate: number;
  granted_by: string;
  expires_at: string;
  created_at: string;
}

export interface GrantPermissionInput {
  tokenId: string;
  jobId: string;
  canDelegate: boolean;
  grantedBy: string;
  durationMinutes: number;
}

/** Create a permission. Returns permission ID. */
export function grantPermission(input: GrantPermissionInput): string {
  const id = crypto.randomUUID();
  const db = getDb();
  const expiresAt = new Date(Date.now() + input.durationMinutes * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO permissions (id, token_id, job_id, can_delegate, granted_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.tokenId,
    input.jobId,
    input.canDelegate ? 1 : 0,
    input.grantedBy,
    expiresAt,
  );
  return id;
}

/** Revoke a permission by ID. */
export function revokePermission(id: string): void {
  getDb().prepare('DELETE FROM permissions WHERE id = ?').run(id);
}

/** Get all active (non-expired) permissions for a job. */
export function getJobPermissions(jobId: string): (Permission & { token_name: string })[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.*, t.name as token_name
    FROM permissions p
    JOIN tokens t ON p.token_id = t.id
    WHERE p.job_id = ? AND p.expires_at > datetime('now')
    ORDER BY p.created_at ASC
  `).all(jobId) as Array<Permission & { token_name: string }>;
  return rows;
}

/** Check if job has active permission for token. Returns the permission or null. */
export function hasPermission(jobId: string, tokenId: string): Permission | null {
  const row = getDb().prepare(`
    SELECT * FROM permissions
    WHERE job_id = ? AND token_id = ? AND expires_at > datetime('now')
    ORDER BY expires_at DESC LIMIT 1
  `).get(jobId, tokenId) as Permission | undefined;
  return row ?? null;
}

/** Delegate a permission from parent to child. Validates parent has can_delegate. */
export function delegatePermission(
  parentJobId: string,
  childJobId: string,
  tokenId: string,
  canDelegate: boolean,
  durationMinutes: number,
): string {
  const parentPerm = hasPermission(parentJobId, tokenId);
  if (!parentPerm) {
    throw new Error('Parent does not have permission for this token');
  }
  if (parentPerm.can_delegate !== 1) {
    throw new Error('Parent does not have delegation rights for this token');
  }
  const parentExpiry = new Date(parentPerm.expires_at).getTime();
  const maxDuration = Math.max(0, Math.floor((parentExpiry - Date.now()) / 60000));
  const actualDuration = Math.min(durationMinutes, maxDuration);
  if (actualDuration <= 0) {
    throw new Error('Parent permission has expired');
  }
  return grantPermission({
    tokenId,
    jobId: childJobId,
    canDelegate,
    grantedBy: parentJobId,
    durationMinutes: actualDuration,
  });
}

// ---------------------------------------------------------------------------
// Project permissions
// ---------------------------------------------------------------------------

export interface ProjectPermission {
  id: string;
  project_dir: string;
  token_id: string;
  can_delegate: number;
  duration_minutes: number;
}

export interface SetProjectPermissionInput {
  projectDir: string;
  tokenId: string;
  canDelegate: boolean;
  durationMinutes: number;
}

/** Get project-level auto-grants for a project directory. */
export function getProjectPermissions(projectDir: string): ProjectPermission[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM project_permissions
    WHERE ? LIKE project_dir || '%'
    ORDER BY project_dir DESC
  `).all(projectDir) as ProjectPermission[];
}

/** Add a project-level auto-grant. Returns ID. */
export function setProjectPermission(input: SetProjectPermissionInput): string {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO project_permissions (id, project_dir, token_id, can_delegate, duration_minutes)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    input.projectDir,
    input.tokenId,
    input.canDelegate ? 1 : 0,
    input.durationMinutes,
  );
  return id;
}

/** Remove a project permission. */
export function removeProjectPermission(id: string): void {
  getDb().prepare('DELETE FROM project_permissions WHERE id = ?').run(id);
}

/** List all project permissions. */
export function listProjectPermissions(): ProjectPermission[] {
  return getDb().prepare('SELECT * FROM project_permissions ORDER BY project_dir, token_id').all() as ProjectPermission[];
}

/** Auto-grant permissions from project defaults when a job is claimed. */
export function autoGrantProjectPermissions(jobId: string, projectDir: string): void {
  const projectPerms = getProjectPermissions(projectDir);
  for (const pp of projectPerms) {
    grantPermission({
      tokenId: pp.token_id,
      jobId,
      canDelegate: pp.can_delegate === 1,
      grantedBy: 'human',
      durationMinutes: pp.duration_minutes,
    });
  }
}

/** Grant permissions from job's stored permissions array (submitted at creation). */
export function grantJobPermissions(
  jobId: string,
  permissions: Array<{ token_name: string; can_delegate?: boolean; duration_minutes?: number }>,
): void {
  const defaultDuration = 60;
  for (const p of permissions) {
    const token = getTokenByName(p.token_name);
    if (!token) continue;
    grantPermission({
      tokenId: token.id,
      jobId,
      canDelegate: p.can_delegate ?? false,
      grantedBy: 'human',
      durationMinutes: p.duration_minutes ?? defaultDuration,
    });
  }
}

// ---------------------------------------------------------------------------
// Permission requests (human approval)
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  id: string;
  token_name: string;
  job_id: string;
  reason: string | null;
  duration_minutes: number;
  can_delegate: number;
  status: 'pending' | 'approved' | 'denied';
  decided_at: string | null;
  decided_reason: string | null;
  created_at: string;
}

export interface CreatePermissionRequestInput {
  tokenName: string;
  jobId: string;
  reason?: string;
  durationMinutes: number;
  canDelegate: boolean;
}

/** Create a permission request. Returns request ID. */
export function createPermissionRequest(input: CreatePermissionRequestInput): string {
  const token = getTokenByName(input.tokenName);
  if (!token) {
    throw new Error(`Unknown token: ${input.tokenName}`);
  }
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO permission_requests (id, token_name, job_id, reason, duration_minutes, can_delegate, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    id,
    input.tokenName,
    input.jobId,
    input.reason ?? null,
    input.durationMinutes,
    input.canDelegate ? 1 : 0,
  );
  return id;
}

/** Get a permission request by ID. */
export function getPermissionRequest(id: string): PermissionRequest | undefined {
  return getDb().prepare('SELECT * FROM permission_requests WHERE id = ?').get(id) as PermissionRequest | undefined;
}

/** List permission requests, optionally filtered by status. */
export function listPermissionRequests(status?: 'pending' | 'approved' | 'denied'): PermissionRequest[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM permission_requests WHERE status = ? ORDER BY created_at ASC').all(status) as PermissionRequest[];
  }
  return db.prepare('SELECT * FROM permission_requests ORDER BY created_at ASC').all() as PermissionRequest[];
}

/** Approve a permission request. Creates permission, updates request. Returns permission ID. */
export function approveRequest(requestId: string, durationMinutes?: number): string {
  const req = getPermissionRequest(requestId);
  if (!req) {
    throw new Error('Permission request not found');
  }
  if (req.status !== 'pending') {
    throw new Error(`Request already ${req.status}`);
  }
  const token = getTokenByName(req.token_name);
  if (!token) {
    throw new Error(`Token ${req.token_name} no longer exists`);
  }
  const duration = durationMinutes ?? req.duration_minutes;
  const permId = grantPermission({
    tokenId: token.id,
    jobId: req.job_id,
    canDelegate: req.can_delegate === 1,
    grantedBy: 'human',
    durationMinutes: duration,
  });
  getDb().prepare(`
    UPDATE permission_requests SET status = 'approved', decided_at = datetime('now') WHERE id = ?
  `).run(requestId);
  return permId;
}

/** Deny a permission request. */
export function denyRequest(requestId: string, reason?: string): void {
  const req = getPermissionRequest(requestId);
  if (!req) {
    throw new Error('Permission request not found');
  }
  if (req.status !== 'pending') {
    throw new Error(`Request already ${req.status}`);
  }
  getDb().prepare(`
    UPDATE permission_requests SET status = 'denied', decided_at = datetime('now'), decided_reason = ? WHERE id = ?
  `).run(reason ?? null, requestId);
}

// ---------------------------------------------------------------------------
// Proxy: find matching token for URL
// ---------------------------------------------------------------------------

/** Find token and permission for a URL. Used by proxy to inject credentials. */
export function findMatchingToken(
  url: string,
  jobId: string,
  projectDir: string,
): { token: Token; permission: Permission } | null {
  const tokens = listTokens(projectDir);
  for (const token of tokens) {
    try {
      const re = new RegExp(token.url_pattern);
      if (!re.test(url)) continue;
    } catch {
      continue; // invalid regex
    }
    const perm = hasPermission(jobId, token.id);
    if (perm) {
      return { token, permission: perm };
    }
  }
  return null;
}

/** Find token matching URL (for no_permission error — token exists but job lacks permission). */
export function findTokenMatchingUrl(url: string, projectDir: string): Token | null {
  const tokens = listTokens(projectDir);
  for (const token of tokens) {
    try {
      const re = new RegExp(token.url_pattern);
      if (re.test(url)) return token;
    } catch {
      continue;
    }
  }
  return null;
}
