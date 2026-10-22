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

Status: implementation complete for HTTP and PostgreSQL transaction scope; multiprocess evidence is not yet available.

- Added `ProcessWagerService` for HTTP and future queue reuse. It executes wager insertion, wallet row lock (`SELECT ... FOR UPDATE`), domain application, wallet version/balance update, optional ledger insert, response snapshot, and outbox rows in one database transaction.
- Implemented BET, WIN, LOSS, REFUND, and ROLLBACK processing with domain reference checks, exact amount matching, same-wallet lock ordering, persistent same-kind reversal lookup, and the database uniqueness constraint as the race-safe backstop.
- Implemented canonical JSON hashing (recursively sorted object keys) of normalized business fields, persistent idempotency and external-operation uniqueness, original response snapshots, same-payload replay, and different-payload conflict.
- Added the required submission and lookup REST routes. Pending reference returns HTTP 202; business rejection returns 422; idempotency and external identity conflicts return 409; transient PostgreSQL lock/serialization failures are retried twice, then return 503.
- Missing REFUND/ROLLBACK references persist as `PENDING_REFERENCE` with an outbox event and no ledger movement. Worker, backoff, TTL, and automatic reprocessing are not included.
- Processed, rejected, pending-reference, and balance-changed envelopes are stored in outbox in the same commit as financial state. LOSS and rejection do not write `WalletBalanceChanged`. Positive wallet opening was minimally extended to store processed and balance-changed events atomically.
- Integration coverage includes 50 concurrent duplicate submissions, concurrent 80.00 BRL bets against 100.00 BRL, original-balance replay after a later change, divergent-payload conflict, pending reference, reversal semantics, LOSS/rejection effects, opening events, and rollback after a forced ledger failure.
- Three-independent-process concurrency is NOT_RUN; this phase has no evidence for that guarantee.
- Final verification on 2026-10-22: `bun test` PASS (53 tests / 223 expectations; 34 domain unit tests and 19 PostgreSQL integration tests), `bun run typecheck` PASS, `bun run build` PASS, and `git diff --check` PASS. The full migration chain completed up → down → up in the disposable integration database.
- HTTP Compose smoke PASS: opened a wallet, issued 50 concurrent identical `POST /wagering/transactions` calls (one non-replay financial effect), then queried by transaction ID and provider/external ID successfully.

## Later phases

Not started. See `implementationPlan.md` in the local workspace; it is intentionally excluded from the evaluation repository.
