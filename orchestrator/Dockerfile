# Agent Harness Orchestrator
# Runs in Docker with docker.sock to spawn sibling sub-agent containers.
# Adapted from NanoClaw's container architecture.

FROM node:22-slim

# Install Docker CLI (for spawning sibling containers via docker.sock)
RUN apt-get update && apt-get install -y \
    curl \
    && curl -fsSL https://get.docker.com | sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# Create data directories
RUN mkdir -p /app/data /app/groups /app/store

# Orchestrator runs as root (needs docker.sock access)
# Sub-agents run as non-root inside their own containers

CMD ["node", "dist/orchestrator.js"]
