# Architecture

## Current phase

Phase 2 adds PostgreSQL persistence without changing the domain boundary. The financial domain lives under `src/domain` and includes exact money, wallet and ledger behavior, wager state transitions, inbox and outbox state, and versioned integration events. The domain imports no NestJS, ORM, PostgreSQL, or SQS packages.

## Initial decisions

- Bun 1.4.3 is the runtime, package manager, and test runner; TypeScript strict mode is enabled.
- `scripts/bootstrap.sh` installs the pinned Bun release when it is missing, then runs `bun install --frozen-lockfile`, typecheck, and build. `DEVELOPMENT.md` describes the reproducible local setup.
- Unit tests use Bun's test runner and are typechecked through `tsconfig.test.json`.
- NestJS 11 hosts the HTTP application.
- MikroORM 7.2.0 with its PostgreSQL driver and migration extension maps persistence-only records under `src/persistence/entities.ts`. Domain values are rehydrated through each domain class's `rehydrate` factory.
- The `WalletOpeningService` application use case depends on `WalletPersistencePort`; `WalletPostgresAdapter` owns MikroORM, SQL, and PostgreSQL error translation. The HTTP controller does not contain persistence rules.
- PostgreSQL 17 and LocalStack SQS 4.12.0 are isolated local dependencies in Docker Compose. This is the last pre-authentication LocalStack image selected for this local test stack; no user token is required.
- LocalStack has separate FIFO command, dead-letter, and event queues. Broker deduplication is not a correctness guarantee.
- No identity provider is configured in Phase 0. The challenge permits documenting an identity-provider extension point; no custom password authentication will be added.
- The application exposes `/health/live` without dependency checks. Readiness will be added with the persistence and messaging adapters.

## Financial consistency

The domain enforces exact `bigint` minor-unit arithmetic, matching currencies, non-negative wallet and ledger balances, balanced immutable ledger entries, explicit wager states, and the business direction of BET, WIN, LOSS, REFUND, and ROLLBACK. Wallet movements return the ledger entry that records the same before and after balance.

## PostgreSQL persistence and Phase 2 scope

`src/persistence/migrations/Migration20261022090000.ts` creates wallets, wager transactions, ledger entries, inbox records, and outbox records. `Migration20261022100000` adds the stable ledger cursor index and blocks `TRUNCATE` in addition to row updates and deletes. `Migration20261022110000` adds child-side FK indexes for wallet, reference, and transaction lookups. Monetary columns use `NUMERIC(38,2)` and are read as decimal strings; neither the domain nor persistence adapters convert an amount to JavaScript `number`.

Wallet opening runs in one `EntityManager.transactional()` scope. A zero opening inserts only the wallet. A positive opening inserts the wallet, an internal processed `OPENING` wager with a stored result balance, and one `CREDIT` ledger row. The unique `(player_id,currency)` constraint arbitrates concurrent creation; the losing transaction rolls back and the API returns 409.

The schema enforces non-negative wallet and ledger balances, version >= 1, provider idempotency and external-operation uniqueness, one ledger row per wallet/transaction, exact before/after arithmetic, transaction/wallet/currency foreign keys, and one processed reversal of a given kind per reference. An append-only trigger rejects ledger UPDATE, DELETE, and TRUNCATE. Partial indexes cover pending-reference work, due outbox work, processed reversal uniqueness, and non-null reference lookups; a `(wallet_id,created_at,id)` index serves stable ledger pages. Child-side wallet and transaction indexes support FK checks and wallet lookup. Unique constraints provide the lookup indexes for wallets, provider idempotency, external transaction, and wallet/transaction keys.

The `GET /wallets/:walletId/ledger` cursor is opaque base64url over `(createdAt,id)` and pages in stable descending order. Reconciliation reads the materialized balance and ledger aggregate in a repeatable-read transaction; it reports a difference and never repairs data.

`bun run db:migrate` applies migrations. `bun run db:rollback` reverses the latest migration. Migrations are not automatically run by API startup. PostgreSQL-backed tests use an explicitly named disposable database (`wagering_phase2_test`) and verify `up → down → up` before exercising SQL guarantees. `docker-compose.yml` gives the API a container-network database URL; local Bun commands use the `DATABASE_URL` in `.env.example`.

Processing BET/WIN/LOSS/REFUND/ROLLBACK requests, applying the planned per-wallet `SELECT ... FOR UPDATE` lock to wager races, persistent inbox/outbox workflows, event publication, SQS consumers, and crash recovery remain future phases. The lock strategy is accepted as a PostgreSQL row lock inside the same unit-of-work transaction; wallet opening uses the unique key because there is no existing wallet row to lock. Phase 2 prepares the persistence port and transaction boundary without implementing the Phase 3 wager processor.
