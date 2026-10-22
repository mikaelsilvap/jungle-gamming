# Distributed Wagering Processor

A NestJS service for processing financial wagering operations over HTTP and Amazon SQS. PostgreSQL is the authority for wallet balances, idempotency, the append-only ledger, the SQS inbox, and the transactional outbox. The system is designed to remain consistent under duplicate delivery, concurrent requests, out-of-order references, and process restarts.

## Contents

- [Technology](#technology)
- [Prerequisites and quick start](#prerequisites-and-quick-start)
- [Configuration](#configuration)
- [Migrations](#migrations)
- [HTTP API](#http-api)
- [SQS commands and events](#sqs-commands-and-events)
- [Financial invariants](#financial-invariants)
- [Idempotency and concurrency](#idempotency-and-concurrency)
- [Inbox and transactional outbox](#inbox-and-transactional-outbox)
- [Recovery and shutdown](#recovery-and-shutdown)
- [Health and metrics](#health-and-metrics)
- [Testing and validation](#testing-and-validation)
- [Architecture](#architecture)
- [Security](#security)
- [Known limitations](#known-limitations)

## Technology

- Bun 1.4.3 for runtime, package installation, scripts, and tests
- TypeScript 5.9 in strict mode
- NestJS 11 for HTTP adapters
- PostgreSQL 17 with MikroORM 7.2 and reversible migrations
- AWS SDK for JavaScript v3 and SQS
- LocalStack 4.12.0 for local SQS
- Docker Compose for local services

The domain layer under `src/domain` is independent of NestJS, MikroORM, PostgreSQL, and SQS.

## Prerequisites and quick start

Install Docker Engine with the Compose plugin and Bun 1.4.3. `scripts/bootstrap.sh` installs the pinned Bun release with the official installer when it is missing, then performs a frozen dependency install, typecheck, and build. It refuses to use a different Bun version.

```bash
bash scripts/bootstrap.sh
docker compose up -d --build
docker compose ps
```

Apply migrations explicitly; application startup does not change the database schema:

```bash
export DATABASE_URL=postgresql://wagering_app:local_only_change_me@localhost:5432/wagering
bun run db:migrate
bun run smoke
curl --fail http://127.0.0.1:3000/health/ready
```

The API is bound to loopback on port 3000. PostgreSQL and LocalStack are also bound to loopback. Worker diagnostic ports are only exposed inside the Compose network.

For an isolated, disposable, one-command verification from a clean Compose project, run:

```bash
bun run validate
```

The validator creates a uniquely named Compose project and volume, creates a separate test database, applies runtime migrations, runs the real PostgreSQL and LocalStack suite, verifies all five wager kinds over HTTP, sends an SQS command through the running consumer, checks the event outbox, then stops and restores PostgreSQL and LocalStack to prove readiness recovery. It removes only its own uniquely named containers, network, and volume on exit. It never targets a pre-existing Compose project. Ports default to `25432` (PostgreSQL), `24566` (LocalStack), and `23000` (API); override them with `VALIDATION_POSTGRES_PORT`, `VALIDATION_LOCALSTACK_PORT`, and `VALIDATION_API_PORT` if those ports are occupied. Set `KEEP_VALIDATION_STACK=true` to retain the isolated project for inspection.

Stop the regular development stack with `docker compose down`. PostgreSQL data remains in its named volume. `docker compose down -v` deletes that development database volume and should only be used when intentionally discarding it.

## Configuration

Copy `.env.example` to `.env` for regular local use and change the local-only password if needed. `.env` is ignored by Git. The values in `.env.example` are fictional development values, not credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_DB` | `wagering` | Compose runtime database |
| `POSTGRES_USER` | `wagering_app` | Local database user |
| `POSTGRES_PASSWORD` | `local_only_change_me` | Local-only password; replace outside a disposable environment |
| `POSTGRES_PORT` | `5432` | Loopback PostgreSQL host port |
| `API_HOST_PORT` | `3000` | Loopback API host port |
| `LOCALSTACK_PORT` | `4566` | Loopback LocalStack host port |
| `DATABASE_URL` | local PostgreSQL URL | Connection string used by API and migration commands |
| `AWS_REGION` | `us-east-1` | SQS region |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | LocalStack-only dummy credentials |
| `SQS_ENDPOINT` | `http://localhost:4566` on host | LocalStack SQS endpoint |
| `SQS_COMMAND_QUEUE_URL` | LocalStack command FIFO | Incoming wager commands |
| `SQS_DLQ_QUEUE_URL` | LocalStack command DLQ | Poison command messages |
| `SQS_EVENTS_QUEUE_URL` | LocalStack event FIFO | Published outbox events |

Compose overrides service-to-service URLs with the internal DNS name `localstack` and the PostgreSQL service name `postgres`. Never put real AWS credentials in `.env.example`, Compose, test fixtures, or source control.

## Migrations

Apply all migrations to the regular local database:

```bash
bun run db:migrate
```

Revert only the most recent migration with `bun run db:rollback`. Do not run rollback against a database containing data you need. Migrations are not run automatically by the API or workers.

## HTTP API

All monetary amounts are decimal strings with exactly two fractional digits. `OPENING` is internal and cannot be submitted through HTTP or SQS.

### Create a wallet

```bash
curl -i http://127.0.0.1:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

A positive opening creates the wallet, internal processed `OPENING` transaction, credit ledger row, and corresponding outbox events in one PostgreSQL transaction. A zero opening creates no artificial financial transaction or ledger row. A duplicate `(playerId,currency)` returns `409`.

### Submit a wager

```bash
curl -i http://127.0.0.1:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -H 'X-Correlation-Id: request-123' \
  -d '{
    "providerId":"provider-a",
    "externalTransactionId":"transaction-123",
    "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId":"0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId":"round-987",
    "gameId":"fortune-chimp",
    "kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}
  }'
```

Supported kinds are `BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK`. `REFUND` and `ROLLBACK` require `referenceExternalTransactionId`; `WIN` may include a BET reference. The response contains `transactionId`, `status`, the balance snapshot, and `idempotentReplay`.

| Result | HTTP status |
| --- | ---: |
| Invalid request | 400 |
| Missing wallet or transaction | 404 |
| Processed operation or replay | 200 |
| Idempotency or external transaction conflict | 409 |
| Business rejection with stable `failureCode` | 422 |
| Accepted pending reference | 202 |
| Exhausted transient database retry | 503 |

### Read and reconcile

```text
GET  /wallets/:walletId
GET  /wallets/:walletId/ledger?cursor=<opaque>&limit=50
GET  /wagering/transactions/:transactionId
GET  /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
GET  /health/live
GET  /health/ready
GET  /metrics
```

Ledger pagination uses a stable opaque cursor over `(createdAt,id)`, in descending order. `limit` must be from 1 to 100 and defaults to 50. Reconciliation compares the wallet's stored balance with a repeatable-read ledger reconstruction; it reports a difference and never repairs data silently.

### Wager examples

For `WIN`, `LOSS`, `REFUND`, and `ROLLBACK`, keep the same provider, player, wallet, round, and currency as the referenced transaction where a reference is required. A refund must match a processed BET and its full amount. A rollback must match a processed BET, WIN, or REFUND and its full amount. Each reference can be refunded once and rolled back once. Invalid references and reversals that would overdraw the wallet are rejected with stable codes.

## SQS commands and events

LocalStack provisions three queues:

- `wager-transactions.fifo` accepts `WagerTransactionRequested` commands.
- `wager-transactions-dlq.fifo` receives poison commands under the configured redrive policy (`maxReceiveCount=5`).
- `wager-events.fifo` receives versioned integration events from the outbox publisher.

The consumer validates the command envelope and calls the same `ProcessWagerService` as HTTP. Use `MessageGroupId=walletId` when producing commands. PostgreSQL wallet locks, uniqueness, and transactions remain the financial correctness authority; FIFO ordering and the broker's bounded deduplication window are not durable idempotency guarantees.

The event types are `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, and `WagerTransactionPendingReference`. Event payloads store decimal-string money. Events are sent only to the separate event queue, never back to the command queue. Event delivery is at-least-once; downstream consumers must persistently deduplicate by `eventId`.

Example command body:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

## Financial invariants

- `Money` uses immutable `bigint` minor units in the domain; contracts and PostgreSQL adapters use exact fixed-scale decimal text. Money is never converted through JavaScript `number`.
- Wallet currency is fixed, balance cannot be negative, and wallet version changes only when the balance changes.
- A balance change and its ledger row are written together. The ledger validates exact before/movement/after arithmetic and PostgreSQL rejects `UPDATE`, `DELETE`, and `TRUNCATE`.
- `BET` debits; `WIN` and a valid `REFUND` credit; `LOSS` records an outcome without moving balance; `ROLLBACK` reverses the referenced movement.
- Rejected and pending-reference transactions do not create ledger movements. A pending reference is resolved by a persistent worker using the same domain validation.
- Database constraints enforce wallet uniqueness, provider idempotency and external-operation uniqueness, ledger uniqueness and arithmetic, foreign keys, non-negative balances, and one processed reversal per `(reference,kind)`.

## Idempotency and concurrency

`Idempotency-Key` is mandatory. The key is scoped by provider. The SHA-256 payload hash uses canonical JSON with recursively sorted object keys over normalized business fields; headers and transport metadata are excluded. PostgreSQL unique constraints arbitrate concurrent requests across processes.

An identical replay returns the persisted original status, failure code, and balance snapshot. Reusing a key with a different payload returns `409` without committing financial effects. The external transaction identity is independently unique per provider.

Every wager transaction locks its wallet row with `SELECT ... FOR UPDATE` inside the financial transaction. Operations for one wallet serialize; different wallets do not share a lock. Deadlock and serialization failures receive a bounded retry, then return a transient `503`. No in-memory mutex participates in correctness.

## Inbox and transactional outbox

For SQS input, `(consumerName,messageId)` and a canonical envelope hash are persisted in the Inbox. Inbox receipt, wager result, wallet update, optional ledger entry, and outbox events share one SQL transaction. The consumer acknowledges the SQS receipt only after that transaction commits. A matching redelivery is acknowledged without applying the operation again; a divergent message identity is treated as invalid.

The financial transaction records versioned events in the SQL outbox in the same commit. Independent publishers claim due records using `FOR UPDATE SKIP LOCKED` and persisted lease tokens, commit the claim, and only then call SQS. Only the earliest unpublished event per wallet is eligible. A matching unexpired claim is required to update publication state. Other wallets can progress independently.

If the publisher crashes after SQS accepts an event but before PostgreSQL records `published_at`, it may send the same event again. This is expected at-least-once delivery. Consumers use the stable event ID for durable deduplication.

## Recovery and shutdown

Missing or not-yet-processed REFUND/ROLLBACK references are stored as `PENDING_REFERENCE` and retried by a separate worker. The configured policy starts at 60 seconds, doubles up to 30 minutes, expires after 24 hours, and stops after 64 attempts. Reschedules do not emit duplicate pending events; final result, optional ledger entry, response snapshot, and outbox event commit atomically.

The SQS consumer long-polls, renews message visibility while processing, applies bounded backoff to transient errors, and relies on the command queue redrive policy for poison messages. On SIGTERM it stops new polling and drains active deliveries. A crash after commit but before ACK causes redelivery, which the Inbox safely deduplicates.

The pending-reference worker stores claim leases in PostgreSQL so another process can recover work after a crash. The outbox publisher also uses leases and claim fencing. All three workers are independent Compose services and can be replicated.

## Health and metrics

- `/health/live` reports process liveness only.
- `/health/ready` runs bounded PostgreSQL `SELECT 1` and SQS `GetQueueAttributes` probes. It returns 503 when either required dependency is unavailable and recovers without a restart.
- `GET /metrics` exposes Prometheus text for the API process. Each worker has a separate internal-only metrics/health server: consumer `9101`, reference worker `9102`, publisher `9103`.
- Structured JSON logs carry a validated correlation ID and allow-listed identifiers. Request bodies, monetary values, credentials, authentication headers, and raw exception messages are excluded.

Metrics are in-memory and process-local: counters and histograms reset on restart and scaled replicas are not aggregated. Outbox lag uses PostgreSQL state; SQS queue depth is approximate. The consumer's DLQ counter is a receive-limit signal, not a broker-confirmed redrive receipt.

## Testing and validation

```bash
bun run typecheck
bun run build
bun test
```

`bun test` includes unit tests and real PostgreSQL/LocalStack integration tests. The integration suite refuses any database whose name differs from `TEST_DATABASE_NAME` (default `wagering_phase2_test`) and executes the migration chain up → down → up. It creates unique SQS queues and exercises database concurrency, consumer redelivery, DLQ, publisher retry/order, process crashes, health behavior, and reconciliation.

For a disposable test database in an already running regular Compose stack:

```bash
docker compose exec -T postgres createdb -U wagering_app wagering_phase2_test
export TEST_DATABASE_NAME=wagering_phase2_test
export DATABASE_URL=postgresql://wagering_app:local_only_change_me@127.0.0.1:5432/wagering_phase2_test
export SQS_ENDPOINT=http://127.0.0.1:4566
export SQS_COMMAND_QUEUE_URL=http://127.0.0.1:4566/000000000000/wager-transactions.fifo
export SQS_DLQ_QUEUE_URL=http://127.0.0.1:4566/000000000000/wager-transactions-dlq.fifo
export SQS_EVENTS_QUEUE_URL=http://127.0.0.1:4566/000000000000/wager-events.fifo
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
bun test
```

GitHub Actions uses pinned Bun 1.4.3 and runs `bun run validate`, including the build, migrations, PostgreSQL and LocalStack-backed tests, and the end-to-end smoke. A green local workflow-equivalent does not imply a GitHub-hosted run has occurred; check the Actions page for the target repository's actual status.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the component diagram, transaction boundaries, schema invariants, lock order, failure behavior, security decisions, trade-offs, and limitations.

## Security

No authentication provider is implemented. This is allowed by the challenge; provider authentication and authorization are explicit integration points and are not implied by request identifiers. Do not expose the unauthenticated API or worker diagnostics directly to a public network. Health endpoints are intentionally unauthenticated. Production deployment requires an external OIDC identity provider, network policy, secret management, and operational access controls.

The Compose credentials are fictional, local-only defaults. Use a non-production database and dummy AWS credentials for tests. `.env`, private keys, local state, `node_modules`, build output, and internal planning material are ignored or excluded from the delivery repository.

## Known limitations

- There is no OIDC provider, authorization policy, public deployment, or production secrets manager.
- Metrics are process-local; there is no collector, central aggregation, dashboard, or alert manager.
- SQS DLQ depth is approximate and event delivery remains at-least-once. A downstream event consumer is not part of this repository.
- Authentication, rate limiting, API request-size policy, and production network hardening require deployment-specific work.
- PostgreSQL credentials and LocalStack credentials in the default Compose setup are for local development only.
- The integration suite validates a disposable database through the full migration rollback/reapply path; never point its `TEST_DATABASE_NAME` at a database with data to preserve.
