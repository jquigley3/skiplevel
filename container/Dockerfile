# Agent Harness — Sandboxed Claude Code CLI
# Lightweight container for running Claude Code in isolation
# Modeled on NanoClaw's container approach

FROM node:22-slim

# Install minimal system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create workspace directories
RUN mkdir -p /workspace/project /workspace/pkb /home/node/.claude

# Configure git identity for sub-agent commits
RUN git config --global user.name "agent-harness-sub-agent" \
    && git config --global user.email "sub-agent@agent-harness.local"

# Create entrypoint wrapper that fixes installMethod before launching claude.
# --output-format=stream-json (set by orchestrator) makes claude emit one JSON
# event per line, which streams cleanly through pipes without needing unbuffer.
RUN printf '#!/bin/sh\nif [ ! -f /home/node/.claude.json ]; then\n  echo '\''{"installMethod":"npm"}'\'' > /home/node/.claude.json\nfi\nexec claude "$@"\n' > /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

# Set ownership to node user (non-root)
RUN chown -R node:node /workspace /home/node

# Switch to non-root user
USER node

# Working directory is the project
WORKDIR /workspace/project

# Entrypoint writes minimal .claude.json then runs claude
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
