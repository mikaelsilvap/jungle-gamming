# Implementation progress

## Phase 0 — Audit and bootstrap

Status: complete for the bootstrap scope.

- Read the official challenge README and local copy.
- Read the supplied implementation plan and project instructions.
- Audited the workspace; no application source, existing domain, dependencies, migrations, tests, or starter project were present.
- Rebuild decision: no application starter or reusable domain code existed, so the bootstrap was created from the challenge contract.
- Initialized a local Git repository on branch `main`; the approved bootstrap was committed as `1ff7894` (`chore: bootstrap wagering challenge and document architecture`). No remote is configured.
- Added the NestJS/Bun bootstrap, local PostgreSQL/LocalStack Compose configuration, FIFO command/DLQ/event queues, and initial CI workflow.
- Bun 1.4.3 is pinned in project metadata and container images. `scripts/bootstrap.sh` installs that exact Bun version when absent, then performs a frozen dependency install, typecheck, and build.
- Added `DEVELOPMENT.md` with the local bootstrap sequence. The LocalStack Compose health check accepts both `running` and `available` SQS service states.
- `bun install --frozen-lockfile`, `bun run typecheck`, and `bun run build` passed.
- `docker compose config` passed; `docker compose up -d --build` built the API image and started PostgreSQL, LocalStack, and NestJS containers.
- All three containers reported healthy. `GET /health/live` returned `{"status":"ok"}`.
- A real `psql` query returned `wagering:wagering_app`; LocalStack listed all three FIFO queues, the command queue had the expected DLQ redrive policy, and a temporary FIFO smoke message was sent, received, and deleted.
- No unit or financial tests existed in the workspace during Phase 0.
- The first LocalStack tag attempted required an auth token, so the Compose pin was changed to the tested pre-authentication `4.12.0` release. No auth token or real credential was added.

The LocalStack and PostgreSQL containers remain running with isolated local test data. No business data was inserted.

## Phase 1 — Financial domain and unit tests

Status: complete for the in-memory domain scope.

- Added an independent domain module with immutable exact `Money`, `Wallet`, `WagerTransaction`, immutable `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, stable failure codes, and the four required integration events.
- Wallet credits, debits, and wager application create a mathematically consistent ledger entry; LOSS changes no balance or version; positive wallet opening creates at most one opening ledger entry per domain instance.
- Wager rules cover BET, WIN (including optional processed BET reference), LOSS, REFUND, and ROLLBACK; invalid references, repeated same-kind reversals on the same reference object, mismatched amounts, and rollback overdraw have distinct domain outcomes.
- Added 34 unit tests and configured `tsconfig.test.json` so both the domain and tests are typechecked.
- `bun test`: PASS, 34 tests and 145 expectations.
- `bun run typecheck`: PASS for application and test TypeScript.
- `bun run build`: PASS.
- Unit tests prove local domain invariants only. They do not prove persistent uniqueness across processes, crash recovery, or SQS/PostgreSQL behavior; database uniqueness remains required in later phases.

Commit: `feat(domain): implement precise money and wagering invariants`.

## Phase 2 — PostgreSQL persistence, migrations, and atomic wallet opening

Status: implementation complete; persistence integration gate passed against PostgreSQL 17.11 in Docker.

- Added MikroORM 7.2.0, PostgreSQL driver, migration extension, five persistence record mappings, and explicit `rehydrate` mappers. Domain files remain independent of NestJS and persistence libraries.
- Separated `WalletOpeningService` from `WalletPostgresAdapter` through `WalletPersistencePort`. The adapter owns SQL, transaction scope, and database error mapping; the application service constructs domain objects without importing MikroORM.
- Added reversible `Migration20261022090000` for wallets, wagers, ledger, inbox, and outbox, `Migration20261022100000` for stable ledger cursor indexing and append-only TRUNCATE protection, and `Migration20261022110000` for child-side FK indexes. The schema enforces wallet/player/currency uniqueness, non-negative balance, valid versions, provider idempotency/external identity uniqueness, ledger uniqueness and arithmetic, and a partial unique guard for each processed reversal kind/reference.
- Added exact `NUMERIC(38,2)` adapters using decimal text and no JavaScript numeric conversion for money.
- Added transactional wallet opening and `POST /wallets`: zero balance creates no artificial wager/ledger; positive opening creates one internal processed `OPENING` and one `CREDIT`; concurrent duplicate openings are serialized by the unique database constraint and the losing transaction is rolled back.
- Added wallet lookup, stable cursor ledger listing, and read-only repeatable-read reconciliation as specified by the implementation plan.
- Added dedicated PostgreSQL integration tests. An injected database trigger failure verified rollback removes the wallet, opening wager, and ledger together.
- Integration test command: `DATABASE_URL=postgresql://wagering_app:local_only_change_me@127.0.0.1:5432/wagering_phase2_test TEST_DATABASE_NAME=wagering_phase2_test bun run test:integration` — PASS, 11 tests / 40 expectations. The suite runs the full migration chain up, down to zero, then up again.
- `DATABASE_URL=... TEST_DATABASE_NAME=... bun test` — PASS, 45 tests / 185 expectations, including all domain unit tests and PostgreSQL integrations.
- `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build`, `docker compose config`, and `git diff --check` — PASS.
- Docker Compose rebuilt successfully; the API and PostgreSQL reported healthy. The compiled migration command ran against the Compose database, and the temporary API instance returned POST wallet 201, duplicate wallet 409, GET wallet 200, GET ledger 200, and POST reconciliation 200 with `consistent: true` and zero difference.
- Created the explicitly disposable `wagering_phase2_test` database for integrations. The regular local `wagering` database received the approved migrations and no demonstration wallet or transaction rows.

Commits: `feat(persistence): add PostgreSQL schema and mappings`; `feat(wallets): add atomic wallet opening and integration coverage`.

## Phase 3 — Wagering and idempotency

Status: implementation complete; HTTP/PostgreSQL guarantees and multiprocess evidence are recorded below.

- Added `ProcessWagerService` for HTTP and future queue reuse. It executes wager insertion, wallet row lock (`SELECT ... FOR UPDATE`), domain application, wallet version/balance update, optional ledger insert, response snapshot, and outbox rows in one database transaction.
- Implemented BET, WIN, LOSS, REFUND, and ROLLBACK processing with domain reference checks, exact amount matching, same-wallet lock ordering, persistent same-kind reversal lookup, and the database uniqueness constraint as the race-safe backstop.
- Implemented canonical JSON hashing (recursively sorted object keys) of normalized business fields, persistent idempotency and external-operation uniqueness, original response snapshots, same-payload replay, and different-payload conflict.
- Added the required submission and lookup REST routes. Pending reference returns HTTP 202; business rejection returns 422; idempotency and external identity conflicts return 409; transient PostgreSQL lock/serialization failures are retried twice, then return 503.
- Missing REFUND/ROLLBACK references persist as `PENDING_REFERENCE` with an outbox event and no ledger movement. Phase 4 adds leased worker retries, backoff, TTL, and automatic reprocessing.
- Processed, rejected, pending-reference, and balance-changed envelopes are stored in outbox in the same commit as financial state. LOSS and rejection do not write `WalletBalanceChanged`. Positive wallet opening was minimally extended to store processed and balance-changed events atomically.
- Integration coverage includes 50 concurrent duplicate submissions, concurrent 80.00 BRL bets against 100.00 BRL, original-balance replay after a later change, divergent-payload conflict, pending reference, reversal semantics, LOSS/rejection effects, opening events, and rollback after a forced ledger failure.
- Three-independent-API concurrency, persistent idempotency across instances, and independent-wallet progress were validated in Phase 4; see below.
- Final verification on 2026-10-22: `bun test` PASS (53 tests / 223 expectations; 34 domain unit tests and 19 PostgreSQL integration tests), `bun run typecheck` PASS, `bun run build` PASS, and `git diff --check` PASS. The full migration chain completed up → down → up in the disposable integration database.
- HTTP Compose smoke PASS: opened a wallet, issued 50 concurrent identical `POST /wagering/transactions` calls (one non-replay financial effect), then queried by transaction ID and provider/external ID successfully.

## Phase 4 — Pending reference recovery and multiprocess validation

Status: implementation and local validation complete for pending-reference recovery and the explicitly authorized Phase 3 multiprocess gap.

- Added a reversible migration for reference TTL and worker lease fields, including a backfill for existing pending references and an index for due work.
- Added deterministic exponential retry policy (60-second initial delay, 30-minute cap, 24-hour TTL, 64-attempt maximum), stable expiry/exhaustion errors, and a standalone polling worker. Claims use `FOR UPDATE SKIP LOCKED`; wallet-first lock ordering is preserved when resuming a wager.
- Pending rows retain their original response snapshot. Rescheduling increments attempts without emitting another pending event; final success/rejection, optional ledger movement, response snapshot, and outbox events share one SQL transaction.
- HTTP idempotency replays return immutable original response status/failure-code/balance snapshots; transaction lookup reports current status and persisted outcome balance. Migrations `Migration20261022130000` and `Migration20261022140000` preserve those snapshots through worker resolution.
- Added integration coverage for reference-before-arrival, pending reference after processing, retries, expiry, invalid identity, competing claims, lease expiry, worker restart, outbox uniqueness, and ledger reconciliation.
- Final test suite after snapshot and attempt-limit coverage: `bun test` PASS (61 tests / 266 expectations), `bun run typecheck` PASS, `bun run build` PASS, and `git diff --check` PASS. PostgreSQL integration migration chain passed up → down → up, including `Migration20261022130000` and `Migration20261022140000`. The final API image was rebuilt, its migrations applied to the local runtime database, and `/health/live` returned `{"status":"ok"}`.
- Three independent API containers: 50 duplicate requests across three instances produced one non-replay financial effect; two concurrent 80.00 BRL bets against 100.00 BRL produced one HTTP 200, one HTTP 422, final balance 20.00, and one debit ledger entry.
- Independent-wallet progress: while a PostgreSQL-observed lock/sleep barrier held wallet A, an API operation on wallet B completed and returned the expected persisted balance before the barrier was released.
- Post-commit crash: after PostgreSQL showed PROCESSED and while a test-gated API response delay was active, the API container was killed. A retry through another instance returned HTTP 200 with `idempotentReplay=true` and the original 90.00 response balance; exactly one ledger entry and the two expected outbox events existed.
- Worker concurrency and crash recovery: two independent worker processes contended for one due row; PostgreSQL showed one lease owner. Both processes were killed during the test-only post-claim pause. After the persisted lease expired, the normal Compose worker reclaimed the row, advanced attempts from 1 to 2, rescheduled it, cleared the lease, and kept the row `PENDING_REFERENCE`; no ledger row or duplicate pending event was created.
- A real missing-reference row was used for the worker crash/restart proof and remains pending in the local development database. It is test data, not application fixture data.

## Phase 5 — SQS consumer, Inbox, retry, and DLQ

Status: implementation and crash/restart integration gate passed against PostgreSQL and LocalStack.

- Added an AWS SDK v3 standalone FIFO consumer and Compose service. It long-polls the command queue, validates the README envelope, uses a stable consumer identity, renews visibility while processing, and drains active work on SIGTERM.
- Extended the existing shared `ProcessWagerService` with an Inbox-aware entry point. Inbox identity, canonical full-envelope SHA-256, financial transaction, wallet/ledger changes, response state, and outbox events are finalized in the same PostgreSQL transaction. The HTTP processing contract remains unchanged.
- Matching processed-message redelivery is acknowledged without repeating financial work. Same message ID with a different payload is rejected durably only by retry/DLQ (no Inbox completion or financial effects). Distinct message IDs for the same provider operation rely on existing persistent business idempotency.
- Durable business rejection and pending-reference acceptance are acknowledged after commit. The pending-reference worker later resumes the operation. Transient failures use exponential SQS visibility (1 second base, capped at 30 seconds); permanent invalid messages use the queue's native redrive policy (`maxReceiveCount=5`). Command queue visibility is 60 seconds, with long polling at 20 seconds and a heartbeat during processing. Messages within one FIFO group remain ordered; different groups can progress concurrently.
- Added real PostgreSQL + LocalStack FIFO integration coverage for valid messages, repeated message IDs, business idempotency across message IDs, divergent payload, insufficient funds, same-wallet competition, independent wallets, pending reference recovery, PostgreSQL serialization retry, post-commit DeleteMessage failure/redelivery, and poison message DLQ.
- Added real-queue integration cases for two independent consumer instances processing separate FIFO groups and for stopping/draining a committed in-flight delivery.
- Resumed the outstanding Phase 5 audit: a standalone Bun consumer process was SIGKILLed after PostgreSQL committed the Inbox and before SQS ACK. A separately started consumer received the expired-visibility message, logged the Inbox duplicate, acknowledged it, and retained exactly one wager, one ledger entry, and a reconciled wallet.
- Final `bun test` against Docker PostgreSQL 17 and LocalStack 4.12.0: PASS, 80 tests / 385 expectations, including all domain, persistence, wagering, pending-reference, SQS, abrupt consumer process-crash/restart, and outbox publisher cases. A first unrestricted `bun test` attempt was refused because it targeted the development database; the safety guard prevented any test from running there, and the rerun with the explicitly disposable database passed.
- `bun run typecheck`: PASS; `bun run build`: PASS; `docker compose config --quiet`: PASS; `docker compose build sqs-consumer`: PASS; `git diff --check`: PASS.
- Started the compiled `sqs-consumer` Compose service and stopped it with Docker's SIGTERM path; logs confirmed ORM startup and `wager_sqs_shutdown_complete`. The in-flight drain behavior was also exercised with a real SQS delivery and PostgreSQL Inbox commit by stopping the consumer loop while the post-commit pause was active; it acknowledged the message and left one reconciled financial effect.
- Restarted LocalStack to execute `localstack/init/ready.d/10-create-wager-queues.sh`; the init log ended with `Ready.` and queue inspection confirmed visibility 60 seconds and redrive to the FIFO DLQ at five receives.
- No SNS, dashboard, frontend, authentication, Kubernetes, or Terraform was added.

## Phase 6 — Transactional outbox publisher

Status: implementation and local verification complete.

- Added a separate AWS SDK v3 publisher process and Compose service for `wager-events.fifo`.
- Added reversible `Migration20261022150000` with identity-backed `publication_order`, `last_error`, and per-aggregate pending-order index. Existing `attempts`, `next_attempt_at`, claim owner, expiry, and due index are reused.
- Claims use a short `FOR UPDATE SKIP LOCKED` transaction and persistent per-claim tokens. Network sends occur after the claim transaction commits. A stale claim cannot update `published_at` or retry fields after another publisher takes over.
- Only the first unpublished event for a wallet is eligible, preserving the transactionally assigned per-wallet publication order across publisher processes. Different wallet aggregates remain independently claimable.
- Events preserve their stored versioned JSON envelope and event ID; SQS deduplication ID is the event ID and message group is the wallet aggregate. Delivery remains at-least-once; consumers must persistently deduplicate by event ID.
- Failures persist attempts, capped exponential retry time, and bounded `last_error`; events are never discarded or permanently paused after a fixed attempt count.
- Focused `bun test ... --test-name-pattern='transactional outbox publisher'`: PASS, 6 tests / 62 expectations against PostgreSQL and LocalStack. Covered all four event types, per-wallet ordering, no uncommitted publish, confirmed-send mark, actual connection refusal and retry/recovery, two publishers, stale-claim fencing, process crash before send and after send, persistent downstream deduplication, and in-flight SIGTERM completion.
- `Migration20261022150000` passed up → down → up in the disposable integration database. The default local database also rolled back and reapplied the migration; 50 existing outbox rows received distinct publication order values, and all 50 were published with zero pending rows.
- Two built Compose publisher containers were active concurrently. Together they published the 50 pre-existing local outbox events to `wager-events.fifo`; the default database showed `0` pending / `50` published. Both containers logged `outbox_shutdown_complete` after SIGTERM.
- Final `bun run typecheck`, `bun run build`, `docker compose config --quiet`, `docker compose build outbox-publisher`, and `git diff --check`: PASS. No push or remote change was performed.

## Phase 7 — Observability and health checks

Status: implementation and local verification complete for process-local observability, health endpoints, and worker diagnostics.

- Added structured JSON logs with async correlation context across HTTP, wager processing, SQS consumption, pending-reference recovery, and outbox publishing. Log fields are allowlisted; request payloads, financial amounts, credentials, headers, and raw exception messages are excluded.
- Added process-local Prometheus counters, gauges, and histograms for HTTP and financial operations, retries, lock conflicts, pending-reference recovery, SQS receive/retry/DLQ signals, and outbox publication/retry/age. `GET /metrics` exposes API metrics; each standalone worker has private Compose-only diagnostics on its own port.
- Added `/health/live` and dependency-checked `/health/ready` to the API. Worker diagnostics expose liveness/readiness; readiness probes PostgreSQL and SQS. Compose health checks use process liveness for workers and HTTP health routes for the API.
- Readiness samples the actual outbox pending count/age and approximate SQS DLQ depth. The DLQ forwarding counter is a consumer-side receive-limit signal, not a broker-confirmed redrive audit. Metrics are per-process and are not aggregated across replicas.
- Added unit coverage for JSON safety, correlation propagation, metric exposition, and real PostgreSQL + LocalStack HTTP integration coverage for health status, recovery, metrics, wager correlation, and outbox propagation.
- Final `bun run typecheck` and `bun run build`: PASS. Full `bun test` against the disposable PostgreSQL database and LocalStack 4.12.0: PASS, 86 tests / 435 expectations. This includes observability tests and prior domain, persistence, wagering, recovery, consumer, and publisher suites. An initial sandboxed run could not reach the local database; the approved rerun with Docker-backed access passed.
- `docker compose config --quiet` and `git diff --check`: PASS. `docker compose up -d --build` rebuilt and started the API, SQS consumer, pending-reference worker, and outbox publisher. Compose reported all app services, PostgreSQL, and LocalStack healthy.
- Runtime smoke PASS: API `/health/live`, `/health/ready`, and `/metrics` returned HTTP 200; each worker's private `/health/live`, `/health/ready`, and `/metrics` endpoint returned HTTP 200. API readiness reported PostgreSQL and SQS up, zero pending outbox rows, zero lag, and zero DLQ messages.
- Dashboards, centralized metrics aggregation, alerting, and cross-replica metric aggregation remain outside this phase.

## Phase 8 — Final audit, hardening, and delivery preparation

Status: local audit and clean-room validation complete; external submission remains pending review and authorization.

- Replaced the challenge-statement README with evaluator-facing English documentation and expanded the architecture guide with the service boundaries, consistency guarantees, and operational limits.
- Added `scripts/validate.sh` as the shared clean-room command for CI and local review. It uses a uniquely named disposable Compose project and database, runs frozen install/typecheck/build, migrations and the full PostgreSQL/LocalStack suite, then exercises HTTP/SQS/Outbox reconciliation and real dependency outage/recovery. It removes only its own stack unless explicitly retained for diagnosis.
- Updated CI to call the same clean-room validation entry point, pinned Bun, and granted the workflow read-only repository permissions.
- Final clean-room run: PASS, Bun 1.4.3, 86 tests / 435 expectations, migrations up-down-up, all service images healthy, HTTP operations and SQS event publication verified, and PostgreSQL/LocalStack readiness recovered from HTTP 503 to 200 after real container outages.
- The end-to-end smoke initially selected the later `WalletBalanceChanged` event for the same transaction. It now matches `WagerTransactionProcessed`; the full clean-room validation passed after correction.
- Added `reports/final-audit.md` with evidence traceability, findings, limitations, and remote-state caveats. Added a Portuguese technical defense guide outside the repository at `/home/magalu/Documents/Codex/Jungle Gaming - Guia de Defesa Técnica.md`.
- A local pattern scan found no obvious credentials in the tracked worktree/history. A dedicated scanner was unavailable, so dedicated secret scanning is NOT_RUN.
- GitHub repository/branch/hosted-CI status is BLOCKED because no authentication was available. The configured remote was not modified, and no push or submission was performed.

## Later phases

No later implementation phase was started. See `implementationPlan.md` in the local workspace; it is intentionally excluded from the evaluation repository.
