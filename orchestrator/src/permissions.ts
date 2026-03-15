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
