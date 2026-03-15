# Contributing to SkipLevel

Thank you for your interest in contributing to SkipLevel.

## Development Setup

1. Clone the repo:

   ```bash
   git clone https://github.com/jquigley3/skiplevel.git
   cd skiplevel
   cp .env.example .env
   ```

2. Configure credentials in `.env` (see README for details).

3. Build and run:
   ```bash
   ./dev.sh build       # Build all Docker images
   ./dev.sh test        # Run tests (inside a container)
   ./dev.sh typecheck   # TypeScript type-check (inside a container)
   ```

No host Node.js installation required — everything runs in Docker.

## Pull Request Process

1. Fork the repo and create a feature branch from `main`.
2. Make your changes. Ensure:
   - `./dev.sh typecheck` passes
   - `./dev.sh test` passes
3. Open a PR with a clear description of the change.
4. Address any review feedback.

## Reporting Issues

Use the GitHub issue templates for bugs and feature requests. Include steps to reproduce for bugs.
