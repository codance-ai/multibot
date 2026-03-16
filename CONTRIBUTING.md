# Contributing to Multibot

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

1. **Prerequisites**: Node.js 18+ and npm
2. **Clone and install**:
   ```bash
   git clone https://github.com/codance-ai/multibot.git
   cd multibot
   ./scripts/setup.sh
   ```
3. **Start dev server**:
   ```bash
   npm run dev
   ```
4. **Run tests**:
   ```bash
   npm test
   ```

## Submitting Changes

1. Fork the repository
2. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
3. Make your changes and ensure tests pass (`npm test`)
4. Commit with a clear message (see conventions below)
5. Open a Pull Request against `main`

## Code Style

- **TypeScript** throughout -- no plain JavaScript
- Use **Zod** for runtime validation of inputs and schemas
- No hardcoded values -- use configuration or environment variables
- No silent failures -- every `catch` block must log the error
- Keep code generic: no channel-specific or provider-specific logic

## Testing

All PRs must pass `npm test` before merge. If you add new functionality, add corresponding tests.

## Commit Messages

Use concise, descriptive messages:

```
feat: add webhook retry logic
fix: prevent duplicate message processing
refactor: extract shared validation utils
docs: update API configuration guide
test: add coverage for cron scheduler
```

Prefix with `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, or `chore:` as appropriate.

## Questions?

Open an issue for discussion before starting large changes.
