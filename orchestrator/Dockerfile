FROM node:22-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI only (not the full daemon — we use the host socket)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz \
    | tar -xz --strip-components=1 -C /usr/local/bin docker/docker

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Data directory for SQLite
RUN mkdir -p /app/data

CMD ["node", "dist/orchestrator.js"]
