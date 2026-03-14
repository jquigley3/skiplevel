FROM node:22-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (to spawn sibling containers)
RUN curl -fsSL https://get.docker.com | sh

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Data directory for SQLite
RUN mkdir -p /app/data

CMD ["node", "dist/orchestrator.js"]
