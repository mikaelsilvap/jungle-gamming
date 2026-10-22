# Architecture

## Current phase

This repository is in Phase 0. It contains only the NestJS bootstrap and an unauthenticated liveness endpoint. PostgreSQL and LocalStack SQS run in Docker Compose, but no financial processing, database persistence, or queue consumer has been implemented yet.

## Initial decisions

- Bun 1.4.3 is the runtime, package manager, and test runner; TypeScript strict mode is enabled.
- `scripts/bootstrap.sh` installs the pinned Bun release when it is missing, then runs `bun install --frozen-lockfile`, typecheck, and build. `DEVELOPMENT.md` describes the reproducible local setup.
- NestJS 11 hosts the HTTP application.
- PostgreSQL 17 and LocalStack SQS 4.12.0 are isolated local dependencies in Docker Compose. This is the last pre-authentication LocalStack image selected for this local test stack; no user token is required.
- LocalStack has separate FIFO command, dead-letter, and event queues. Broker deduplication is not a correctness guarantee.
- No identity provider is configured in Phase 0. The challenge permits documenting an identity-provider extension point; no custom password authentication will be added.
- The application exposes `/health/live` without dependency checks. Readiness will be added with the persistence and messaging adapters.

## Financial consistency

Not implemented in Phase 0. The planned design uses exact `Money` values, PostgreSQL transactions, row-level wallet locks, a persistent idempotency key, an append-only ledger, inbox/outbox records in the same transaction, and SQS publication only after commit. These guarantees require implementation and real integration tests in later phases; this document does not claim they are already present.
