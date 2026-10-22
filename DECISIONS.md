# Architecture decisions

## ADR-001 — Runtime and framework

Status: accepted for bootstrap.

Use Bun 1.4.3, TypeScript strict mode, and NestJS 11, as required by the challenge. Exact dependency versions are recorded in `package.json` and `bun.lock`.

## ADR-002 — Process and module shape

Status: proposed; financial processes are not implemented yet.

Start as a modular monolith with independently runnable API, SQS consumer, outbox publisher, and pending-reference worker. Share application use cases and PostgreSQL persistence across processes; avoid introducing network services between these components.

## ADR-003 — Exact money representation

Status: accepted for the domain layer.

Represent domain money as integer minor units using `bigint` and expose fixed-scale decimal strings. The domain implementation is independent of database types; the planned PostgreSQL adapter will use exact `NUMERIC(38,2)`. Never convert monetary amounts through JavaScript `number`.

## ADR-004 — Wallet concurrency

Status: accepted and implemented for Phase 3 wager mutations; wallet opening is protected by database uniqueness.

Serialize operations on one existing wallet using a PostgreSQL row lock (`SELECT ... FOR UPDATE`) inside the same transaction as wager, wallet, and ledger writes. Distinct wallets remain independently processable; there is no global lock. Wallet opening cannot lock a row that does not yet exist and instead relies on `UNIQUE(player_id,currency)`. The actual wager lock is implemented in Phase 3 with the wager use case.

## ADR-005 — Financial atomicity and ledger

Status: accepted and implemented for wallet opening and Phase 3 wagers. Financial result, balance, optional ledger, and outbox writes commit together; SQS inbox coordination remains later work.

Commit wallet, wager transaction, append-only ledger, SQS inbox when applicable, and outbox together. Publish outbox events only after commit. Enforce database constraints and ledger immutability in PostgreSQL.

## ADR-006 — Persistent idempotency

Status: accepted and implemented in Phase 3.

Use unique database keys and a SHA-256 hash of recursively sorted canonical business fields. Persist the original response snapshot so a replay returns the original observed balance. Same-key/different-hash is HTTP 409; same-key/same-hash is replay; pending-reference replays remain pending with the original acceptance snapshot.

## ADR-007 — HTTP and SQS share the use case

Status: accepted for the HTTP adapter and future SQS adapter.

HTTP and SQS adapters will invoke one `ProcessWager` application use case. SQS acknowledgment follows the database commit.

## ADR-008 — Transactional outbox and delivery

Status: proposed.

Claim pending outbox rows safely across publishers, publish to the separate FIFO event queue after commit, and retain at-least-once semantics with a stable event identifier.

## ADR-009 — Authentication extension point

Status: accepted for the challenge scope.

Do not implement custom authentication or an identity provider in this timebox. Document an external OIDC provider integration point before delivery. Health endpoints remain public.

## ADR-010 — Currency scope

Status: accepted for the domain layer.

Exercise financial flows in BRL while keeping `Money` currency-aware and rejecting operations across different currencies. The domain validates ISO-4217 codes against the runtime's `Intl` currency data and checks that every arithmetic operation uses matching codes.

## ADR-011 — MikroORM and exact PostgreSQL persistence

Status: accepted and implemented in Phase 2.

Use MikroORM 7.2.0 with persistence-only record classes and `EntitySchema` metadata. This keeps ORM decorators and database types out of the approved domain. Monetary values are stored in PostgreSQL `NUMERIC(38,2)` and passed to/from the domain as decimal strings. Migration SQL is versioned, reversible, and owns the financial checks, unique keys, foreign keys, partial reversal guard, indexes, and append-only ledger trigger.

## ADR-012 — Atomic wallet opening and reconciliation

Status: accepted and implemented in Phase 2.

Create wallet, optional internal `OPENING` wager, and optional initial `CREDIT` ledger row in one `EntityManager.transactional()` callback. A zero-balance wallet has version 1 and no artificial ledger entry. Database uniqueness resolves concurrent player/currency creation; all rows from a losing opening attempt roll back. Reconciliation uses a repeatable-read transaction and only reports stored and ledger-derived values; it does not repair discrepancies.

The application use case depends on `WalletPersistencePort`; `WalletPostgresAdapter` implements that port. This keeps MikroORM, raw SQL, and PostgreSQL exception handling out of the application and domain layers.
