# Contributing to ClawForge

Thank you for your interest in contributing to ClawForge.

## Development Setup

1. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/jquigley3/clawforge.git
   cd clawforge
   npm install
   cd orchestrator && npm install
   ```

2. Copy `.env.example` to `.env` and configure (see README for details).

3. Run the test suite:
   ```bash
   npm test
   ```

## Pull Request Process

1. Fork the repo and create a feature branch from `main`.
2. Make your changes. Ensure:
   - `npm run format:check` passes
   - `npm run typecheck` passes
   - `npm test` passes
3. Open a PR with a clear description of the change.
4. Address any review feedback.

## Code Style

- Use Prettier for formatting (run `npm run format:fix` before committing).
- TypeScript strict mode is enabled; avoid `any` where possible.

## Reporting Issues

Use the GitHub issue templates for bugs and feature requests. Include steps to reproduce for bugs.
