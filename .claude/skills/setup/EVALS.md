# /setup Skill — Eval Plan

Reference: [Improving skill-creator: Test, measure, and refine Agent Skills](https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills)

## Skill Classification

This is an **encoded preference skill** — Claude can already check Docker status
and run shell commands. The skill encodes the *sequence* and *decision logic*
(which steps to skip, when to stop, what to tell the user). Evals should verify
fidelity to that workflow, not raw capability.

---

## Eval Scenarios

Each eval simulates a different starting state and checks that the skill
produces the correct behavior. Run these manually by setting up the state,
invoking `/setup`, and checking the output against expected behavior.

### E1 — Fresh clone, nothing configured

**Setup state:**
- No `.env` file
- No Docker images built
- Docker daemon running

**Expected behavior:**
1. Detects missing `.env`, copies from `.env.example`
2. Stops with credential instructions (does not proceed to image builds)
3. Output contains "credentials" guidance
4. Does NOT attempt to build images or start containers

**Pass criteria:**
- `.env` file created
- Output mentions both API key and OAuth options
- No `docker build` or `docker compose up` commands executed

### E2 — .env exists with API key, nothing else

**Setup state:**
- `.env` with `ANTHROPIC_API_KEY=sk-ant-test-key`
- No Docker images
- Docker running

**Expected behavior:**
1. Detects credentials present
2. Builds images (`./dev.sh build`)
3. Starts orchestrator (`./dev.sh up`)
4. Prints green summary

**Pass criteria:**
- Worker image exists (`docker image inspect macro-claw-worker:latest`)
- Orchestrator container running
- Summary shows all items passing

### E3 — Everything already set up

**Setup state:**
- `.env` with credentials
- Images built
- Orchestrator running

**Expected behavior:**
1. All probes return OK/RUNNING
2. No action taken
3. Prints green summary immediately

**Pass criteria:**
- No `docker build` or `docker compose up` commands run
- Output is a clean summary with all passing

### E4 — --check-only flag

**Setup state:** Any (partially configured)

**Expected behavior:**
1. Reports status of each item
2. Does NOT take any action (no installs, no builds, no starts)

**Pass criteria:**
- Zero side effects (no files created, no commands run beyond probes)
- Output contains status for all 6 items

### E5 — Docker not running

**Setup state:**
- Docker daemon stopped

**Expected behavior:**
1. Detects Docker missing
2. Prints instructions to start Docker
3. Stops immediately — does not check anything else

**Pass criteria:**
- Output mentions Docker Desktop or systemctl
- No other steps attempted

### E6 — OAuth token extraction (macOS)

**Setup state:**
- `.env` exists but no credentials
- Claude Code logged in (token in Keychain)
- `--auto` flag passed

**Expected behavior:**
1. Detects missing credentials
2. Finds token in Keychain
3. Runs `./dev.sh token` automatically (because `--auto`)
4. Proceeds with remaining setup

**Pass criteria:**
- `.env` contains `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...`
- Setup continues past step 3

### E7 — Partial failure recovery

**Setup state:**
- `.env` with credentials
- Worker image built
- Orchestrator image missing (deleted manually)

**Expected behavior:**
1. Detects missing orchestrator image
2. Runs `./dev.sh build` (rebuilds both)
3. Starts orchestrator
4. Prints summary

**Pass criteria:**
- Both images exist after
- Orchestrator running
- Summary reflects recovery

---

## Trigger Evals

Per the blog post: as skill count grows, description precision matters.
Test that `/setup` triggers correctly and doesn't false-trigger.

### Should trigger:
- "set up macro-claw"
- "initialize the project"
- "check if everything is configured"
- "diagnose why the orchestrator won't start"
- "verify my install"
- "first time setup"
- `/setup`
- `/setup --check-only`

### Should NOT trigger:
- "set up a new task" (task creation, not project setup)
- "configure the model for a job" (job config, not setup)
- "install a new npm package" (generic npm, not setup)
- "start the orchestrator" (direct action, not setup workflow)

---

## Benchmark Metrics

When running evals, track:

| Metric | Target | Notes |
|--------|--------|-------|
| Pass rate | 100% E1-E5, E7 | E6 requires macOS + logged-in Claude |
| Steps executed | Minimum necessary | E3 should be near-zero steps |
| False actions | 0 | No action in --check-only mode |
| Stop-on-blocker | 100% | Must stop when credentials missing |
| Token usage | <2K tokens | This is a procedural skill, not creative |
| Wall time | <60s (excl. builds) | Builds are I/O bound, don't count |

---

## Refinement Cycle

From the blog post:

1. **Write evals first** (this file) — define what "correct" looks like
2. **Run benchmark** — invoke `/setup` in each scenario, record pass/fail
3. **Identify failures** — which scenario failed? Why?
4. **Edit the skill** — adjust instructions, probes, or decision logic
5. **Re-run benchmark** — verify the fix didn't regress other scenarios
6. **A/B compare** — if unsure whether a change helped, run both versions

### Common failure modes to watch for:

- **Over-eagerness**: skill runs `docker build` when images already exist
- **Missing stop**: skill proceeds past credential step when creds are missing
- **Wrong probe interpretation**: skill misreads a probe output token
- **Stale probes**: probes check for wrong container/image names
- **Platform assumptions**: skill assumes macOS when running on Linux

### When to re-eval:

- After editing SKILL.md
- After a Claude model update (capability uplift may change behavior)
- After changing the project structure (new Dockerfiles, renamed containers)
