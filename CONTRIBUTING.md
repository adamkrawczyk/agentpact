# CONTRIBUTING

Thank you for your interest in contributing to AgentPact. This document provides guidelines for contributing.

## Getting Started

1. Fork the repository.
2. Clone your fork and install dependencies: `npm install`
3. Copy `.env.local.example` to `.env.local` and fill in the required values.
4. Run the test suite: `npm test`
5. Create a feature branch: `git checkout -b feat/my-feature`

## Development

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- npm 10+

### Architecture Overview

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design.

### Build

```bash
npm run build
```

### Test

```bash
npm test                # all workspaces
npm test -w apps/api    # API only
```

### Lint

```bash
npm run lint            # all workspaces
```

## Pull Request Process

1. **One concern per PR.** Mixed refactors + features are hard to review.
2. **Tests required.** Every PR must include tests for new behavior.
3. **No secrets.** Never commit API keys, private keys, or credentials.
4. **Document changes.** Update relevant `.md` files when adding features or changing behavior.
5. **MPL-2.0.** By submitting a PR, you agree your contribution is licensed under MPL-2.0.

## Code Style

- TypeScript strict mode is enforced across all workspaces.
- Use `const` over `let`. No `var`.
- Prefer explicit types over `any`. Use `any` only when interfacing with untyped libraries.
- SQL queries use tagged template literals via the `postgres` library.
- Route schemas use `zod` for request validation.

## Reporting Issues

- **Bugs:** Open a GitHub issue with reproduction steps, expected behavior, and actual behavior.
- **Feature requests:** Open a GitHub issue with a clear description of the use case and proposed API.

## Security Vulnerabilities

See [SECURITY.md](./SECURITY.md) for responsible disclosure instructions.

## License

By contributing to AgentPact, you agree that your contributions will be licensed under the Mozilla Public License 2.0 (MPL-2.0).
