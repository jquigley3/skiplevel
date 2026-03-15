import os from 'os';
import path from 'path';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.

const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'macro-claw',
  'mount-allowlist.json',
);

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'macro-claw-worker:latest';

export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);

export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);

// Job queue polling interval (ms)
export const JOB_POLL_INTERVAL = parseInt(
  process.env.JOB_POLL_INTERVAL || '5000',
  10,
);

// Maximum concurrent worker containers
export const MAX_CONCURRENT_WORKERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_WORKERS || '1', 10),
);

// Where worktrees are created (orchestrator-visible path)
export const WORKTREES_DIR =
  process.env.WORKTREES_DIR || '/workspace/worktrees';

// SQLite database path
export const DB_PATH = process.env.DB_PATH || './data/macro-claw.db';

// Retry policy for transient API errors (rate limits, overloaded).
// Non-retryable errors (bad prompts, tool failures) always fail immediately.
export const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
export const RETRY_BASE_DELAY_MS = parseInt(
  process.env.RETRY_BASE_DELAY_MS || '30000',
  10,
);

// Timezone for container processes
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
