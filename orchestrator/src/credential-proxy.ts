/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { handleToolRequest } from './tools.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/** Last observed retry-after from 429/529 upstream responses. */
let lastRetryAfter: { retryAfterSeconds: number; observedAt: number } | null = null;

const RETRY_AFTER_STALE_MS = 120_000; // 2 min — if older, treat as unknown

/** Parse retry-after from upstream response headers. Returns seconds or null. */
function parseRetryAfter(
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
): number | null {
  if (statusCode !== 429 && statusCode !== 529) return null;

  const raw = headers['retry-after'];
  if (raw) {
    const s = Array.isArray(raw) ? raw[0] : raw;
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  // Fallback: anthropic-ratelimit-*-reset headers (RFC 3339)
  const resets = [
    headers['anthropic-ratelimit-requests-reset'],
    headers['anthropic-ratelimit-tokens-reset'],
    headers['anthropic-ratelimit-input-tokens-reset'],
    headers['anthropic-ratelimit-output-tokens-reset'],
  ].flatMap((h) => (h ? (Array.isArray(h) ? h : [h]) : []));

  let maxSeconds = 0;
  for (const r of resets) {
    const date = new Date(r);
    if (!Number.isNaN(date.getTime())) {
      const sec = Math.ceil((date.getTime() - Date.now()) / 1000);
      if (sec > maxSeconds) maxSeconds = sec;
    }
  }
  return maxSeconds > 0 ? maxSeconds : null;
}

/** Get last observed retry-after (seconds) if recent. Used when requeuing jobs. */
export function getLastRetryAfterSeconds(): number | null {
  if (!lastRetryAfter) return null;
  if (Date.now() - lastRetryAfter.observedAt > RETRY_AFTER_STALE_MS) return null;
  return lastRetryAfter.retryAfterSeconds;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Health check endpoint — used by Docker healthcheck and monitoring
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, authMode }));
        return;
      }

      // Retry-after from last 429/529 — used by orchestrator when requeuing jobs.
      if (req.method === 'GET' && req.url === '/api/retry-after') {
        const sec = getLastRetryAfterSeconds();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sec != null ? { retryAfterSeconds: sec } : {}));
        return;
      }

      // Tool API — task spawning, polling, job management, token registry.
      if (req.url?.startsWith('/api/tasks') || req.url?.startsWith('/api/jobs') || req.url?.startsWith('/api/tokens')) {
        handleToolRequest(req, res).catch((err) => {
          logger.error({ err, url: req.url }, 'Tool API error');
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            const retrySec = parseRetryAfter(
              upRes.statusCode ?? 0,
              upRes.headers as Record<string, string | string[] | undefined>,
            );
            if (retrySec != null) {
              lastRetryAfter = { retryAfterSeconds: retrySec, observedAt: Date.now() };
              logger.debug({ statusCode: upRes.statusCode, retryAfterSeconds: retrySec }, 'Captured retry-after from upstream');
            }
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
