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

## Phase 2

Not started. PostgreSQL mappings, schema constraints, reversible migrations, and wallet persistence remain pending.

## Later phases

Not started. See `implementationPlan.md` in the local workspace; it is intentionally excluded from the evaluation repository.
