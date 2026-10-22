# Development setup

## Requirements

- Bash and `curl` to install Bun when it is not already installed.
- Docker Engine with the Docker Compose plugin for the local PostgreSQL and LocalStack services.

## Install and verify Bun

The project pins Bun 1.4.3 in `package.json`, the Docker images, and the bootstrap script. To install it in the default user directory and prepare the project:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bash scripts/bootstrap.sh
```

The script installs the exact pinned Bun release when it cannot find that release at `BUN_INSTALL/bin/bun`. It then performs a frozen lockfile install, strict typecheck, and build. If another Bun executable is on `PATH` but has a different version, the script stops with a version error instead of silently switching runtimes.

To keep the Bun installation in a temporary directory, set `BUN_INSTALL` explicitly and add its `bin` directory to `PATH` for subsequent commands:

```bash
export BUN_INSTALL=/tmp/jungle-bun
export PATH="$BUN_INSTALL/bin:$PATH"
bash scripts/bootstrap.sh
```

## Start local infrastructure

```bash
docker compose up -d --build
docker compose ps
```

The Compose stack starts PostgreSQL, LocalStack SQS, the NestJS API, the pending-reference worker, the wager SQS consumer, and the transactional outbox publisher. LocalStack creates the command FIFO, its DLQ, and the separate event FIFO. The worker processes use the same PostgreSQL database and retry while it is unavailable; apply migrations before submitting financial work. The LocalStack health check accepts the SQS states returned by supported LocalStack releases. Verify the API with:

```bash
bun run smoke
```

Stop the stack with `docker compose down`. The PostgreSQL volume is retained; use `docker compose down -v` only when intentionally deleting local database state.

Inspect messaging process logs with:

```bash
docker compose logs -f sqs-consumer outbox-publisher pending-reference-worker
```

The API endpoints `GET /health/live` and `GET /health/ready` bind through the local-only API port. Liveness is process-only; readiness runs a bounded PostgreSQL query and an SQS queue-attributes operation. Query API metrics locally with `curl http://127.0.0.1:3000/metrics`.

Each worker keeps a separate in-memory metrics registry and exposes `/metrics`, `/health/live`, and `/health/ready` on its private Compose network port: `9101` for `sqs-consumer`, `9102` for `pending-reference-worker`, and `9103` for `outbox-publisher`. These ports are not published to the host. Inspect one process without merging replica counters:

```bash
docker compose exec sqs-consumer bun -e "fetch('http://127.0.0.1:9101/metrics').then(r => r.text()).then(console.log)"
docker compose exec pending-reference-worker bun -e "fetch('http://127.0.0.1:9102/metrics').then(r => r.text()).then(console.log)"
docker compose exec outbox-publisher bun -e "fetch('http://127.0.0.1:9103/metrics').then(r => r.text()).then(console.log)"
```

Metrics counters and histogram observations reset when a process restarts. Outbox and DLQ depth metrics are scraped from their live dependencies and are gauges; SQS queue depth is approximate. The consumer redrive counter records deliveries reaching the configured receive limit and left unacknowledged for the native queue policy, not a broker-side transfer receipt.

To check that an outbox event is flowing locally, submit a wallet or wager operation after applying migrations, then inspect the publisher logs and receive from `wager-events.fifo` with the LocalStack AWS CLI. The publisher sends only events already committed to PostgreSQL. Duplicate event delivery is expected after a publisher crash between SQS confirmation and the `published_at` update; downstream consumers must persistently deduplicate using `eventId`.

## Apply PostgreSQL migrations

The API does not run schema changes implicitly. After the stack is healthy, apply the checked-in migrations:

```bash
export DATABASE_URL=postgresql://wagering_app:local_only_change_me@localhost:5432/wagering
bun run db:migrate
```

Use `bun run db:rollback` only against a local development database when intentionally reverting the latest migration.

## Run persistence integration tests

The integration suite refuses to run against a database other than `wagering_phase2_test`. Create this disposable database once in the local Postgres container, then use:

```bash
docker exec jungle-wagering-postgres-1 createdb -U wagering_app wagering_phase2_test
export TEST_DATABASE_NAME=wagering_phase2_test
export DATABASE_URL=postgresql://wagering_app:local_only_change_me@localhost:5432/wagering_phase2_test
bun run test:integration
```

The suite performs migration `up → down → up` and leaves its disposable schema populated with test records. It never drops or truncates the normal `wagering` database.

With the two environment variables above exported, run the full suite with `bun test`. CI provisions the same disposable PostgreSQL database automatically.

## Run clean-room validation

For a disposable stack that does not reuse the development database or ports, run:

```bash
bun run validate
```

The script requires Bun 1.4.3 and Docker Compose. It creates a uniquely named Compose project, uses a disposable PostgreSQL volume and database, reserves host ports 25432 (PostgreSQL), 24566 (LocalStack), and 23000 (API) by default, applies migrations, builds and starts all services, runs the full PostgreSQL/LocalStack test suite, then verifies HTTP, SQS, outbox, ledger reconciliation, and dependency outage/recovery. It removes only that validation project and volume when it exits. Set `VALIDATION_POSTGRES_PORT`, `VALIDATION_LOCALSTACK_PORT`, or `VALIDATION_API_PORT` to avoid local port conflicts. Set `KEEP_VALIDATION_STACK=true` only when intentionally retaining the isolated stack for diagnosis.

The same command is the CI validation entry point. It must be run with Docker access because tests and outage checks use real PostgreSQL and LocalStack services.
