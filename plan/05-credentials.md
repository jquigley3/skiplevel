# 05 — Credentials: API Key and OAuth Token Setup

## How Credentials Work

Worker containers never see real credentials. Instead:

1. Containers get a **placeholder** value (`ANTHROPIC_API_KEY=placeholder` or `CLAUDE_CODE_OAUTH_TOKEN=placeholder`)
2. Containers are told to route API traffic through the credential proxy (`ANTHROPIC_BASE_URL=http://host.docker.internal:3001`)
3. The **credential proxy** (an HTTP server in the orchestrator) intercepts every request and injects the real credentials before forwarding to `api.anthropic.com`

This design means: even if a container is compromised, it cannot exfiltrate your API key or OAuth token.

## Option A: Anthropic API Key (Simplest)

If you have a standard Anthropic API key (`sk-ant-...`), this is the easiest path.

### Setup

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)
2. Add it to your `.env` file:

```bash
# .env (or orchestrator/.env if using docker-compose)
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### How It Works

The credential proxy detects `ANTHROPIC_API_KEY` in the `.env` file and operates in **API key mode**:

- Every request from a container has its `x-api-key` header replaced with the real key
- The container's placeholder `ANTHROPIC_API_KEY=placeholder` is never sent upstream

### Code (already in credential-proxy.ts from nano-claw)

```typescript
if (authMode === 'api-key') {
  delete headers['x-api-key'];
  headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
}
```

## Option B: Claude Code OAuth Token (Personal Use)

If you use Claude Code with your Anthropic account (not an API key), you authenticate via OAuth. Claude Code stores the OAuth token in the macOS Keychain.

### Step 1: Log in to Claude Code

If you haven't already:

```bash
claude login
```

This opens a browser, you authenticate, and Claude Code stores the OAuth token in the macOS Keychain under the service name `Claude Code-credentials`.

### Step 2: Extract the Token from Keychain

The token is stored as a JSON blob in the macOS Keychain. Extract it with:

```bash
# Read the raw keychain entry
RAW=$(security find-generic-password -s "Claude Code-credentials" -w)

# Parse out the access token
TOKEN=$(echo "$RAW" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for key in ('claudeAiOauth', 'claudeAiOAuthToken'):
    val = data.get(key)
    if isinstance(val, dict):
        print(val.get('accessToken', ''))
        break
    elif isinstance(val, str):
        print(val)
        break
")

echo "Token: ${TOKEN:0:20}..."
```

### Step 3: Add to .env

```bash
# .env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

### Step 4: Automate with dev.sh

The `dev.sh` script includes a `token` command that does steps 2-3 automatically:

```bash
./dev.sh token
# Output: ==> Token updated in orchestrator/.env
```

Include this in `dev.sh`:

```bash
cmd_token() {
  command -v security &>/dev/null || { echo "ERROR: macOS 'security' command required"; exit 1; }

  echo "==> Extracting OAuth token from macOS Keychain..."

  local raw
  raw="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)" \
    || { echo "ERROR: Token not found. Run 'claude login' first."; exit 1; }

  local token
  token="$(printf '%s' "$raw" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for key in ('claudeAiOauth', 'claudeAiOAuthToken'):
    val = data.get(key)
    if isinstance(val, dict):
        print(val.get('accessToken', ''))
        break
    elif isinstance(val, str):
        print(val)
        break
" 2>/dev/null)"

  [ -z "$token" ] && token="$raw"  # Fallback for older plain-token format

  local env_file="./orchestrator/.env"
  if grep -q "CLAUDE_CODE_OAUTH_TOKEN" "$env_file" 2>/dev/null; then
    sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$token|" "$env_file"
  else
    echo "CLAUDE_CODE_OAUTH_TOKEN=$token" >> "$env_file"
  fi

  echo "==> Token updated in $env_file"
}
```

### How OAuth Mode Works

The credential proxy detects that `ANTHROPIC_API_KEY` is NOT set but `CLAUDE_CODE_OAUTH_TOKEN` IS set, and operates in **OAuth mode**:

1. The container's Claude CLI starts up with `CLAUDE_CODE_OAUTH_TOKEN=placeholder`
2. The CLI sends an OAuth token exchange request to `/api/oauth/claude_cli/create_api_key` with `Authorization: Bearer placeholder`
3. The credential proxy intercepts this request and replaces `Bearer placeholder` with `Bearer <real-oauth-token>`
4. Anthropic's API returns a temporary API key
5. Subsequent requests from the CLI use this temporary API key via `x-api-key`, which the proxy passes through unmodified

```typescript
// OAuth mode in credential-proxy.ts
if (headers['authorization']) {
  delete headers['authorization'];
  if (oauthToken) {
    headers['authorization'] = `Bearer ${oauthToken}`;
  }
}
```

### Token Refresh

OAuth tokens expire. The orchestrator re-reads the `.env` file on each credential proxy request (via `readEnvFile()`), so updating the token doesn't require a restart. Run `./dev.sh token` to refresh, then the next job dispatch will use the new token.

For the docker-compose setup, the `.env` file is bind-mounted as a live file:

```yaml
volumes:
  - ./orchestrator/.env:/app/.env:ro
```

## .env.example

```bash
# macro-claw — environment configuration
# Copy to .env and fill in values.

# ── Credentials (one of the two below is required) ──────────

# Option A: Anthropic API key (recommended for CI / headless)
# ANTHROPIC_API_KEY=sk-ant-api03-...

# Option B: Claude Code OAuth token (for personal / interactive use)
# Extract from macOS Keychain: ./dev.sh token
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# ── Optional ────────────────────────────────────────────────

# Docker image for worker containers (build with: ./dev.sh build-image)
# CONTAINER_IMAGE=macro-claw-worker:latest

# Max concurrent worker containers (default: 1)
# MAX_CONCURRENT_WORKERS=1

# Worker timeout in ms (default: 1800000 = 30 min)
# CONTAINER_TIMEOUT=1800000

# Log level: trace | debug | info | warn | error
# LOG_LEVEL=info
```

## Security Notes

1. **Never commit `.env`** — it contains secrets. The `.gitignore` should include `.env`.
2. **Containers cannot read the `.env` file** — it is never mounted into worker containers. The credential proxy runs in the orchestrator process and reads it directly.
3. **Placeholder values are harmless** — if a container leaks its env vars, the attacker gets `ANTHROPIC_API_KEY=placeholder`, which is useless.
4. **The credential proxy only listens on the Docker network** — it's not exposed to the internet. On macOS (Docker Desktop), it binds to `0.0.0.0` within the orchestrator container, and Docker's port mapping (`3001:3001`) makes it reachable from sibling containers via `host.docker.internal:3001`.
