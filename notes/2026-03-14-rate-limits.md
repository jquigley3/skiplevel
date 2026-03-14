# Rate Limits & Resource Monitoring

## Two distinct limits to track

### Token limits (usage windows)
Already in resources.yaml. Tracks cumulative token spend per window (5-hour
reset). Tells us when we're about to exhaust budget for a period.

### Rate limits (requests per minute)
**Not yet modeled.** Distinct from token limits — this is requests/minute (RPM)
or requests/day (RPD) at the API level. Hitting this causes immediate 429
errors regardless of remaining token budget.

We got rate limited during parallel sub-agent dispatch (6 agents all making
API calls simultaneously), which triggered the retry loop and hammered limits
further.

## What to monitor

- Current RPM usage vs. limit
- Rate limit reset time (typically per-minute rolling window)
- Whether a sub-agent exit was due to rate limit vs. other failure
  (different recovery strategy applies)

## Open design question (HARNESS-010)

See tasks/HARNESS-010.yaml — needs clarification before implementation.
Key questions:
1. Resume session or restart when rate limited?
2. How to detect rate limit vs. other failure from Claude CLI exit?
3. Which throttle mechanism: agent restart delay, credential proxy, or
   proactive concurrency cap?
