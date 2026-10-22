# Architecture decisions

## ADR-001 — Runtime and framework

Status: accepted for bootstrap.

Use Bun 1.4.3, TypeScript strict mode, and NestJS 11, as required by the challenge. Exact dependency versions are recorded in `package.json` and `bun.lock`.

## ADR-002 — Process and module shape

Status: proposed; financial processes are not implemented yet.

Start as a modular monolith with independently runnable API, SQS consumer, outbox publisher, and pending-reference worker. Share application use cases and PostgreSQL persistence across processes; avoid introducing network services between these components.

## ADR-003 — Exact money representation

Status: proposed.

Represent domain money as integer minor units using `bigint`, expose fixed-scale decimal strings, and persist exact PostgreSQL `NUMERIC(38,2)`. Never convert monetary amounts through JavaScript `number`.

## ADR-004 — Wallet concurrency

Status: proposed.

Serialize operations on one wallet using a PostgreSQL row lock inside the same transaction as wager, wallet, and ledger writes. Distinct wallets remain independently processable.

## ADR-005 — Financial atomicity and ledger

Status: proposed.

Commit wallet, wager transaction, append-only ledger, SQS inbox when applicable, and outbox together. Publish outbox events only after commit. Enforce database constraints and ledger immutability in PostgreSQL.

## ADR-006 — Persistent idempotency

Status: proposed.

Use unique database keys and a SHA-256 hash of canonical business fields. Persist the original response snapshot so a replay returns the original observed balance.

## ADR-007 — HTTP and SQS share the use case

Status: proposed.

HTTP and SQS adapters will invoke one `ProcessWager` application use case. SQS acknowledgment follows the database commit.

## ADR-008 — Transactional outbox and delivery

Status: proposed.

Claim pending outbox rows safely across publishers, publish to the separate FIFO event queue after commit, and retain at-least-once semantics with a stable event identifier.

## ADR-009 — Authentication extension point

Status: accepted for the challenge scope.

Do not implement custom authentication or an identity provider in this timebox. Document an external OIDC provider integration point before delivery. Health endpoints remain public.

## ADR-010 — Currency scope

Status: proposed.

Exercise financial flows in BRL while keeping `Money` currency-aware and rejecting operations across different currencies.
