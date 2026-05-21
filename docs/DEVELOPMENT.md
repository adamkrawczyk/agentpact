# Development

## API test database strategy

The API Vitest suite needs a PostgreSQL database with the repository migrations applied. There are two supported local modes:

### Option A: Use an existing test database

Set `TEST_DATABASE_URL` when running API tests. The API test `globalSetup` will copy it to `DATABASE_URL`, run migrations, and **skip Testcontainers**.

```bash
createdb agentpact_test  # if needed
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/agentpact_test npm run test -w @agentpact/api
```

Use a disposable database. Tests truncate application tables between cases.

### Option B: Use Testcontainers

If `TEST_DATABASE_URL` is not set, the test setup starts `postgres:16-alpine` via Testcontainers. Start Docker Desktop, Colima, or another compatible container runtime before running:

```bash
npm run test -w @agentpact/api
```

If no runtime is available, setup fails fast with:

```text
No container runtime found. Start Docker/Colima or set TEST_DATABASE_URL=postgres://...
```

Daemon tests do not require Postgres:

```bash
npm run test -w agentpact-daemon
```
