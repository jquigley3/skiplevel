"""
Agent Harness API Proxy — mitmproxy addon

Runs in reverse-proxy mode between sub-agents and api.anthropic.com:
  Sub-agents  →  HTTP :8000  →  mitmproxy  →  HTTPS api.anthropic.com

Features:
  - Proactive throttling: hold requests when RPM or ITPM bucket is exhausted
  - Reactive 429 handling: queue all requests for retry-after seconds
  - 529 overload handling: exponential backoff (30s → 300s)
  - Parse rate limit headers (anthropic-ratelimit-*) on every response
  - Extract token usage from SSE stream and JSON response bodies
  - Expose live stats via HTTP on :8001

Rate limit headers (Anthropic sends on every response):
  anthropic-ratelimit-requests-{limit,remaining,reset}
  anthropic-ratelimit-input-tokens-{limit,remaining,reset}
  anthropic-ratelimit-output-tokens-{limit,remaining,reset}
  anthropic-ratelimit-tokens-{limit,remaining,reset}  (most restrictive combined view)

Reset values are RFC 3339 timestamps; we convert them to monotonic wake targets.
"""

import asyncio
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

from mitmproxy import http

STATS_PORT = 8001
log = logging.getLogger("harness-proxy")

# Proactive throttle: hold requests when remaining drops to or below this fraction
# of the limit. 0 = only hold when fully exhausted.
THROTTLE_THRESHOLD = 0


def _parse_reset(reset_str: Optional[str]) -> float:
    """Convert an RFC 3339 reset timestamp to a monotonic wake time.

    Returns 0.0 if the string is absent or unparseable.
    """
    if not reset_str:
        return 0.0
    try:
        reset_dt = datetime.fromisoformat(reset_str.replace("Z", "+00:00"))
        delay = (reset_dt - datetime.now(timezone.utc)).total_seconds()
        return time.monotonic() + max(0.0, delay)
    except (ValueError, AttributeError):
        return 0.0


@dataclass
class ProxyStats:
    # ── Requests rate limit ────────────────────────────────────────────────────
    rpm_limit: Optional[int] = None
    rpm_remaining: Optional[int] = None
    rpm_reset: Optional[str] = None
    _requests_reset_at: float = field(default=0.0, repr=False)  # monotonic

    # ── Input tokens rate limit ────────────────────────────────────────────────
    itpm_limit: Optional[int] = None
    itpm_remaining: Optional[int] = None
    itpm_reset: Optional[str] = None
    _input_tokens_reset_at: float = field(default=0.0, repr=False)  # monotonic

    # ── Output tokens rate limit ───────────────────────────────────────────────
    otpm_limit: Optional[int] = None
    otpm_remaining: Optional[int] = None
    otpm_reset: Optional[str] = None
    _output_tokens_reset_at: float = field(default=0.0, repr=False)  # monotonic

    # ── Cumulative usage counters ──────────────────────────────────────────────
    total_requests: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    session_start: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    # ── 429 rate limit state ───────────────────────────────────────────────────
    rate_limited: bool = False
    _rate_limited_until: float = field(default=0.0, repr=False)  # monotonic
    retry_after_seconds: Optional[int] = None
    last_429_at: Optional[str] = None

    # ── 529 overload state ─────────────────────────────────────────────────────
    overloaded: bool = False
    _overloaded_until: float = field(default=0.0, repr=False)  # monotonic
    overload_backoff_seconds: int = 0
    last_529_at: Optional[str] = None

    # ── Queue depth (display only) ─────────────────────────────────────────────
    queued_requests: int = 0

    def as_json(self) -> str:
        d = asdict(self)
        # Strip private fields (monotonic timestamps — not useful to callers)
        for key in list(d.keys()):
            if key.startswith("_"):
                d.pop(key)
        return json.dumps(d, indent=2)


stats = ProxyStats()


def _parse_sse_usage(body: bytes) -> None:
    """Extract token counts from an Anthropic SSE stream.

    Relevant events:
      message_start  {"type":"message_start","message":{"usage":{"input_tokens":N,...}}}
      message_delta  {"type":"message_delta","usage":{"output_tokens":N}}
    """
    for line in body.split(b"\n"):
        if not line.startswith(b"data: "):
            continue
        payload = line[6:].strip()
        if not payload or payload == b"[DONE]":
            continue
        try:
            event = json.loads(payload)
            t = event.get("type")
            if t == "message_start":
                usage = event.get("message", {}).get("usage", {})
                stats.total_input_tokens += usage.get("input_tokens", 0)
            elif t == "message_delta":
                usage = event.get("usage", {})
                stats.total_output_tokens += usage.get("output_tokens", 0)
        except (json.JSONDecodeError, AttributeError):
            continue


class HarnessProxyAddon:
    async def request(self, flow: http.HTTPFlow) -> None:
        """Hold requests when rate limited or when buckets are exhausted."""
        now = time.monotonic()

        # ── Reactive: 429 hold ─────────────────────────────────────────────────
        remaining_429 = stats._rate_limited_until - now
        if remaining_429 > 0:
            stats.queued_requests += 1
            log.info("Rate limited (429) — holding request for %.1fs", remaining_429)
            await asyncio.sleep(remaining_429)
            stats.queued_requests -= 1
            return

        # ── Reactive: 529 backoff ──────────────────────────────────────────────
        remaining_529 = stats._overloaded_until - now
        if remaining_529 > 0:
            stats.queued_requests += 1
            log.info("API overloaded (529) — backing off for %.1fs", remaining_529)
            await asyncio.sleep(remaining_529)
            stats.queued_requests -= 1
            return

        # ── Proactive: requests bucket exhausted ───────────────────────────────
        if stats.rpm_remaining is not None and stats.rpm_remaining <= THROTTLE_THRESHOLD:
            delay = stats._requests_reset_at - time.monotonic()
            if delay > 0:
                stats.queued_requests += 1
                log.info(
                    "RPM exhausted (%d remaining) — holding for %.1fs",
                    stats.rpm_remaining,
                    delay,
                )
                await asyncio.sleep(delay)
                stats.queued_requests -= 1

        # ── Proactive: input token bucket exhausted ────────────────────────────
        if stats.itpm_remaining is not None and stats.itpm_remaining <= THROTTLE_THRESHOLD:
            delay = stats._input_tokens_reset_at - time.monotonic()
            if delay > 0:
                stats.queued_requests += 1
                log.info(
                    "ITPM exhausted (%d remaining) — holding for %.1fs",
                    stats.itpm_remaining,
                    delay,
                )
                await asyncio.sleep(delay)
                stats.queued_requests -= 1

    async def response(self, flow: http.HTTPFlow) -> None:
        """Parse rate limit headers and token usage from every response."""
        h = flow.response.headers
        status = flow.response.status_code

        # ── Rate limit headers ─────────────────────────────────────────────────
        # Anthropic sends anthropic-ratelimit-* (not x-ratelimit-*)
        try:
            if "anthropic-ratelimit-requests-limit" in h:
                stats.rpm_limit = int(h["anthropic-ratelimit-requests-limit"])
                stats.rpm_remaining = int(
                    h.get("anthropic-ratelimit-requests-remaining", 0)
                )
                stats.rpm_reset = h.get("anthropic-ratelimit-requests-reset")
                stats._requests_reset_at = _parse_reset(stats.rpm_reset)

            if "anthropic-ratelimit-input-tokens-limit" in h:
                stats.itpm_limit = int(h["anthropic-ratelimit-input-tokens-limit"])
                stats.itpm_remaining = int(
                    h.get("anthropic-ratelimit-input-tokens-remaining", 0)
                )
                stats.itpm_reset = h.get("anthropic-ratelimit-input-tokens-reset")
                stats._input_tokens_reset_at = _parse_reset(stats.itpm_reset)

            if "anthropic-ratelimit-output-tokens-limit" in h:
                stats.otpm_limit = int(h["anthropic-ratelimit-output-tokens-limit"])
                stats.otpm_remaining = int(
                    h.get("anthropic-ratelimit-output-tokens-remaining", 0)
                )
                stats.otpm_reset = h.get("anthropic-ratelimit-output-tokens-reset")
                stats._output_tokens_reset_at = _parse_reset(stats.otpm_reset)

        except (ValueError, TypeError):
            pass

        # ── 429 rate limited ───────────────────────────────────────────────────
        if status == 429:
            retry_after = 60
            try:
                retry_after = int(h.get("retry-after", 60))
            except (ValueError, TypeError):
                pass
            stats.rate_limited = True
            stats._rate_limited_until = time.monotonic() + retry_after
            stats.retry_after_seconds = retry_after
            stats.last_429_at = datetime.now(timezone.utc).isoformat()
            log.warning("429 from Anthropic — queuing requests for %ds", retry_after)
            return

        # ── 529 overloaded ─────────────────────────────────────────────────────
        if status == 529:
            backoff = min((stats.overload_backoff_seconds or 15) * 2, 300)
            stats.overloaded = True
            stats._overloaded_until = time.monotonic() + backoff
            stats.overload_backoff_seconds = backoff
            stats.last_529_at = datetime.now(timezone.utc).isoformat()
            log.warning("529 from Anthropic — backing off for %ds", backoff)
            return

        # ── Clear transient flags once windows pass ────────────────────────────
        now = time.monotonic()
        if stats.rate_limited and now >= stats._rate_limited_until:
            stats.rate_limited = False
        if stats.overloaded and now >= stats._overloaded_until:
            stats.overloaded = False
            stats.overload_backoff_seconds = 0

        # ── Token usage from successful responses ──────────────────────────────
        # Claude Code uses the streaming API (text/event-stream), so usage
        # arrives in SSE events, not a single JSON body:
        #   message_start  → message.usage.input_tokens
        #   message_delta  → usage.output_tokens
        if status == 200:
            content_type = flow.response.headers.get("content-type", "")
            try:
                if "text/event-stream" in content_type:
                    _parse_sse_usage(flow.response.content)
                else:
                    body = json.loads(flow.response.content)
                    usage = body.get("usage", {})
                    stats.total_input_tokens += usage.get("input_tokens", 0)
                    stats.total_output_tokens += usage.get("output_tokens", 0)
            except (json.JSONDecodeError, AttributeError):
                pass

        stats.total_requests += 1

    async def running(self) -> None:
        """Start the stats HTTP server once mitmproxy is ready."""
        asyncio.ensure_future(_serve_stats())
        log.info("Harness proxy ready — stats on :%d", STATS_PORT)


# ── Stats HTTP server ────────────────────────────────────────────────────────


async def _handle_stats(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    try:
        await asyncio.wait_for(reader.read(4096), timeout=5.0)
        body = stats.as_json().encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/json\r\n"
            b"Access-Control-Allow-Origin: *\r\n"
            + f"Content-Length: {len(body)}\r\n".encode()
            + b"\r\n"
            + body
        )
        await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()


async def _serve_stats() -> None:
    server = await asyncio.start_server(_handle_stats, "0.0.0.0", STATS_PORT)
    async with server:
        await server.serve_forever()


addons = [HarnessProxyAddon()]
