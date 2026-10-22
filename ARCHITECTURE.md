# Architecture

## Current phase

This repository has completed Phase 1. The financial domain lives under `src/domain` and includes exact money, wallet and ledger behavior, wager state transitions, inbox and outbox state, and versioned integration events. The domain imports no NestJS, ORM, PostgreSQL, or SQS packages.

## Initial decisions

- Bun 1.4.3 is the runtime, package manager, and test runner; TypeScript strict mode is enabled.
- `scripts/bootstrap.sh` installs the pinned Bun release when it is missing, then runs `bun install --frozen-lockfile`, typecheck, and build. `DEVELOPMENT.md` describes the reproducible local setup.
- Unit tests use Bun's test runner and are typechecked through `tsconfig.test.json`.
- NestJS 11 hosts the HTTP application.
- PostgreSQL 17 and LocalStack SQS 4.12.0 are isolated local dependencies in Docker Compose. This is the last pre-authentication LocalStack image selected for this local test stack; no user token is required.
- LocalStack has separate FIFO command, dead-letter, and event queues. Broker deduplication is not a correctness guarantee.
- No identity provider is configured in Phase 0. The challenge permits documenting an identity-provider extension point; no custom password authentication will be added.
- The application exposes `/health/live` without dependency checks. Readiness will be added with the persistence and messaging adapters.

## Financial consistency

The domain enforces exact `bigint` minor-unit arithmetic, matching currencies, non-negative wallet and ledger balances, balanced immutable ledger entries, explicit wager states, and the business direction of BET, WIN, LOSS, REFUND, and ROLLBACK. Wallet movements return the ledger entry that records the same before and after balance.

Persistence and distributed guarantees are not implemented yet. PostgreSQL transaction boundaries, database-enforced uniqueness and ledger immutability, persistent idempotency, inbox/outbox atomicity, SQS delivery, retries across processes, and crash recovery belong to later phases and require real integration tests.
