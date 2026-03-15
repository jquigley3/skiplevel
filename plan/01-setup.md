# 01 — Fork and Strip nano-claw

## Step 1: Clone nano-claw

```bash
# Clone nano-claw as the starting point
git clone https://github.com/jmandel/nanoclaw.git macro-claw
cd macro-claw
rm -rf .git
git init
git add -A
git commit -m "Initial commit: forked from nano-claw"
```

## Step 2: Delete What You Don't Need

Remove these directories and files entirely:

```bash
# Channels — macro-claw has no chat integrations
rm -rf src/channels/

# Agent runner — we use `claude --print`, not the Agent SDK
rm -rf container/agent-runner/

# Router — no outbound message delivery
rm src/router.ts

# Task scheduler — no cron/scheduled tasks
rm src/task-scheduler.ts

# Group queue — we'll replace with a simpler concurrency limiter
rm src/group-queue.ts

# Group folder resolution — we use worktrees, not group folders
rm src/group-folder.ts

# Types that reference channels/groups
rm src/types.ts

# IPC watcher — we'll replace with transcript capture
rm src/ipc.ts

# The existing index.ts — we'll rewrite as orchestrator.ts
rm src/index.ts

# The existing db.ts — we'll rewrite with a simpler schema
rm src/db.ts

# Container skills (chat-specific)
rm -rf container/skills/

# Groups directory (chat-specific)
rm -rf groups/

# Data directory (runtime state)
rm -rf data/

# Docs (we'll write our own)
rm -rf docs/
```

## Step 3: What to Keep (and Why)

### Keep as-is:

- `src/container-runtime.ts` — Docker binary detection, host gateway, orphan cleanup
- `src/credential-proxy.ts` — HTTP proxy for credential injection (API key + OAuth)
- `src/mount-security.ts` — allowlist-based mount validation
- `src/config.ts` — environment variable reading (will need minor edits)
- `src/env.ts` — `.env` file parser (keep secrets out of process.env)
- `src/logger.ts` — pino logger
- `container/Dockerfile` — node:22-slim + Claude Code CLI (keep as-is)

### Adapt:

- `src/container-runner.ts` — keep the core spawning logic, adapt mounts and transcript capture
- `package.json` — rename, add `better-sqlite3` dependency
- `docker-compose.yaml` — simplify (orchestrator only, no channels)
- `tsconfig.json` — keep as-is
- `.env.example` — simplify

## Step 4: Install New Dependencies

```bash
# Add SQLite
npm install better-sqlite3
npm install -D @types/better-sqlite3

# Verify existing deps are still there
npm install
```

## Step 5: Update package.json

```json
{
  "name": "macro-claw",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/orchestrator.js",
    "dev": "tsx src/orchestrator.ts",
    "test": "node node_modules/tsx/dist/cli.mjs --test test/*.test.ts"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "pino": "^9.6.0",
    "pino-pretty": "^13.0.0",
    "yaml": "^2.7.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

## Step 6: Update config.ts

Strip out channel/group-specific config. Keep container and credential proxy settings. Add:

```typescript
// Job queue polling interval
export const JOB_POLL_INTERVAL = parseInt(
  process.env.JOB_POLL_INTERVAL || '5000',
  10,
); // 5s

// Maximum concurrent worker containers
export const MAX_CONCURRENT_WORKERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_WORKERS || '1', 10),
);

// Where worktrees are created (host path)
export const WORKTREES_DIR =
  process.env.WORKTREES_DIR || '/workspace/worktrees';
export const HOST_WORKTREES_DIR =
  process.env.HOST_WORKTREES_DIR || WORKTREES_DIR;

// SQLite database path
export const DB_PATH = process.env.DB_PATH || './data/macro-claw.db';
```

Remove references to: `GROUPS_DIR`, `STORE_DIR`, `DATA_DIR` (nano-claw-specific), `SENDER_ALLOWLIST_PATH`, `IPC_POLL_INTERVAL`.

## Expected File Structure After Cleanup

```
macro-claw/
├── src/
│   ├── orchestrator.ts        # NEW — main loop
│   ├── db.ts                  # NEW — SQLite job queue
│   ├── worker.ts              # ADAPTED from container-runner.ts
│   ├── credential-proxy.ts    # KEPT from nano-claw
│   ├── container-runtime.ts   # KEPT from nano-claw
│   ├── mount-security.ts      # KEPT from nano-claw
│   ├── config.ts              # ADAPTED
│   ├── env.ts                 # KEPT from nano-claw
│   └── logger.ts              # KEPT from nano-claw
├── container/
│   └── Dockerfile             # KEPT from nano-claw
├── test/
│   ├── smoke.test.ts          # NEW
│   └── fake-agent.sh          # NEW
├── data/                      # Created at runtime (SQLite DB lives here)
├── docker-compose.yaml        # SIMPLIFIED
├── dev.sh                     # NEW — developer CLI
├── .env.example               # SIMPLIFIED
├── package.json
├── tsconfig.json
└── README.md
```
