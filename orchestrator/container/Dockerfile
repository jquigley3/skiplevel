# macro-claw worker — sandboxed Claude Code CLI
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Workspace directories
RUN mkdir -p /workspace/project /home/node/.claude

# Git identity for agent commits
RUN git config --global user.name "macro-claw-worker" \
    && git config --global user.email "worker@macro-claw.local"

# Entrypoint: write .claude.json then exec claude
RUN printf '#!/bin/sh\nif [ ! -f /home/node/.claude.json ]; then\n  echo '"'"'{"installMethod":"npm"}'"'"' > /home/node/.claude.json\nfi\nexec claude "$@"\n' > /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

RUN chown -R node:node /workspace /home/node

USER node
WORKDIR /workspace/project

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
