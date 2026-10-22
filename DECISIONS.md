# Architecture decisions

## ADR-001 — Runtime and framework

Status: accepted for bootstrap.

Use Bun 1.4.3, TypeScript strict mode, and NestJS 11, as required by the challenge. Exact dependency versions are recorded in `package.json` and `bun.lock`.

## ADR-002 — Process and module shape

Status: accepted; API, pending-reference worker, and SQS consumer are implemented as independently runnable processes.

Start as a modular monolith with independently runnable API, SQS consumer, outbox publisher, and pending-reference worker. Share application use cases and PostgreSQL persistence across processes; avoid introducing network services between these components.

## ADR-003 — Exact money representation

Status: accepted for the domain layer.

Represent domain money as integer minor units using `bigint` and expose fixed-scale decimal strings. The domain implementation is independent of database types; the planned PostgreSQL adapter will use exact `NUMERIC(38,2)`. Never convert monetary amounts through JavaScript `number`.

## ADR-004 — Wallet concurrency

Status: accepted and implemented for Phase 3 wager mutations; wallet opening is protected by database uniqueness.

Serialize operations on one existing wallet using a PostgreSQL row lock (`SELECT ... FOR UPDATE`) inside the same transaction as wager, wallet, and ledger writes. Distinct wallets remain independently processable; there is no global lock. Wallet opening cannot lock a row that does not yet exist and instead relies on `UNIQUE(player_id,currency)`. The actual wager lock is implemented in Phase 3 with the wager use case.

## ADR-005 — Financial atomicity and ledger

Status: accepted and implemented for wallet opening, Phase 3 wagers, and Phase 5 SQS processing. Financial result, balance, optional ledger, Inbox state when applicable, and outbox writes commit together.

Commit wallet, wager transaction, append-only ledger, SQS inbox when applicable, and outbox together. Publish outbox events only after commit. Enforce database constraints and ledger immutability in PostgreSQL.

## ADR-006 — Persistent idempotency

Status: accepted and implemented in Phase 3.

Use unique database keys and a SHA-256 hash of recursively sorted canonical business fields. Persist the original response status, failure code, and balance so a replay returns the original response. Same-key/different-hash is HTTP 409; same-key/same-hash is replay; pending-reference replays retain their original PENDING_REFERENCE status and acceptance snapshot after background resolution. Transaction lookup reports current transaction status and the persisted outcome balance, not the wallet's live balance.

## ADR-007 — HTTP and SQS share the use case

Status: accepted and implemented for the HTTP adapter and Phase 5 SQS consumer.

HTTP and SQS adapters invoke the shared `ProcessWagerService`; SQS does not contain financial rules. The consumer stores a canonical full-envelope SHA-256 hash keyed by stable consumer name and SQS message ID in the same PostgreSQL transaction as wager, wallet, ledger, and outbox changes. SQS acknowledgment uses the receipt handle for the current delivery and follows the database commit.

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

## ADR-013 — Pending reference recovery

Status: accepted and implemented in Phase 4.

Persist each pending reversal's expiry, next-attempt time, attempt count, and temporary worker lease in PostgreSQL. Workers claim batches with `FOR UPDATE SKIP LOCKED`; a lease lets another process recover work after a crash. The worker acquires the wallet lock before wager/reference locks, then reuses the domain transition and reference validation rules. Retry policy is 60-second initial delay, exponential backoff capped at 30 minutes, a 24-hour TTL, and 64 maximum attempts. Expiry and terminal failures are recorded as rejected outcomes. Reschedules do not add another pending event; final outcome, optional ledger entry, response snapshot, and outbox events commit atomically. These settings are operational defaults and can be revisited from observed provider latency.

The migration backfills pre-existing pending rows with the same TTL and initial delay. The worker is a standalone local Compose process. The worker holds the pending-row lock during the transaction after checking lease ownership; another claimant cannot take the row while it is locked. Pending idempotency replay intentionally preserves the original acceptance snapshot, while transaction lookup reports current state.

## ADR-014 — SQS Inbox, redelivery, and shutdown

Status: accepted and implemented in Phase 5.

Use AWS SDK for JavaScript v3 in a standalone FIFO consumer process. Long-poll the command queue, process each MessageGroupId in order, and process distinct groups concurrently. PostgreSQL wallet locks remain the financial concurrency authority; MessageGroupId is an ordering and throughput aid. Use a stable consumer name and `(consumer_name,message_id)` Inbox identity with canonical full-envelope SHA-256 validation. A matching completed Inbox row is a durable duplicate; a divergent payload for the same identity is permanently invalid. Commit Inbox, wager result, balance, optional ledger, and outbox in one SQL transaction. ACK only after commit, including durable business rejections and pending references. Transient errors receive bounded exponential visibility delay; permanent invalid messages are retried only until the queue RedrivePolicy moves them to the FIFO DLQ (`maxReceiveCount=5`). Renew message visibility during processing. SIGTERM stops new polling and drains active work; a post-commit crash is recovered through Inbox deduplication on redelivery. The outbox publisher remains Phase 6.
