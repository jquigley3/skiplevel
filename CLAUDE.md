# macro-claw

macro-claw is a job orchestrator that runs agent tasks in Docker containers. This file is for the interactive session (you, helping the user). The agents running inside containers are a separate context — they get their own instructions.

## Submitting Jobs With Permissions

When submitting a job that needs external API access (GitHub, Jira, etc.), pre-grant permissions so the agent doesn't have to request them:

```bash
./submit.sh /path/to/project "Review the latest PRs" \
  --permission "github-ro:delegate:60" \
  --permission "jira-read::30"
```

Format: `token_name:delegate_flag:duration_minutes`. Use `delegate` if the agent should be able to pass the permission to child tasks. Leave it empty (`::`) otherwise.

## Managing Tokens

Tokens are registered secrets the proxy uses to inject credentials into agent HTTP requests. Agents never see the actual secret values.

```bash
./tokens.sh add \
  --name github-ro \
  --url-pattern "https://api\\.github\\.com/repos/myorg/.*" \
  --header Authorization \
  --value "Bearer ghp_xxxxxxxxxxxx" \
  --description "Read-only GitHub access for myorg" \
  --project /path/to/project

./tokens.sh list
./tokens.sh remove github-ro
```

## Project-Level Auto-Grants

Auto-grant a token to every job in a project directory so agents don't need to request it each time:

```bash
./permissions.sh project-add \
  --project /path/to/project \
  --token github-ro \
  --can-delegate \
  --duration 60
```

## Approving Permission Requests

Agents running in containers can request permissions they weren't pre-granted. Review and approve from the host:

```bash
./permissions.sh pending
./permissions.sh approve <request-id>
./permissions.sh approve <request-id> --duration 15
./permissions.sh deny <request-id> --reason "Not needed"
```

## Agent-Facing Documentation

`developer/permissions.md` contains the instructions agents receive for using the proxy, checking permissions, requesting access, and delegating to child tasks. When configuring a job's system prompt or helping the user set up tasks, reference this file to understand what agents will see. Do not follow those instructions yourself — they are for containerized agents, not this session.

## Rebuilding After Code Changes

After modifying orchestrator code, run:

```bash
bash rebuild-and-verify.sh
```

This rebuilds Docker images, bounces the stack, and verifies health. If it fails, read the output for diagnostics.
