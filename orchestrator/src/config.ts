import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([]);

// Absolute paths — these are inside the orchestrator container
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Projects root — where harness-managed projects live (container path)
export const PROJECTS_DIR = process.env.PROJECTS_DIR || '/workspace/projects';

// PKB root — read-only reference for sub-agents (container path)
export const PKB_DIR = process.env.PKB_DIR || '/workspace/pkb';

// Host paths — the orchestrator runs in Docker but spawns sibling containers
// that mount host paths. These map container paths → host paths for mounts.
export const HOST_PROJECTS_DIR = process.env.HOST_PROJECTS_DIR || PROJECTS_DIR;
export const HOST_PKB_DIR = process.env.HOST_PKB_DIR || PKB_DIR;

// Orchestrator state directories
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');

// Mount security: allowlist stored OUTSIDE project root
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'agent-harness',
  'mount-allowlist.json',
);

// Container settings
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'agent-harness:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '3', 10) || 3,
);

// Rate-limiting proxy
// When set, sub-agents route Anthropic API calls through this URL.
// Leave empty to bypass (e.g. local dev without compose).
export const RATE_LIMIT_PROXY_URL = process.env.RATE_LIMIT_PROXY_URL || '';
// Stats endpoint for the proxy — orchestrator queries this at dispatch time.
export const PROXY_STATS_URL = process.env.PROXY_STATS_URL || '';
// Docker network sub-agents join so they can reach the proxy.
export const HARNESS_NETWORK = process.env.HARNESS_NETWORK || '';

// Task polling
export const TASK_POLL_INTERVAL = parseInt(
  process.env.TASK_POLL_INTERVAL || '5000',
  10,
); // 5s

// IPC
export const IPC_POLL_INTERVAL = 1000;

// Timezone
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Sender allowlist — not used in harness but kept for compatibility
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'agent-harness',
  'sender-allowlist.json',
);
