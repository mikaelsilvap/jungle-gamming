import { Migration } from '@mikro-orm/migrations';

export class Migration20261022090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance_amount numeric(38,2) not null check (balance_amount >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_id_player_currency_unique unique (id, player_id, currency)
      );

      create table wager_transactions (
        id uuid primary key,
        provider_id text not null check (length(provider_id) > 0),
        external_transaction_id text not null check (length(external_transaction_id) > 0),
        idempotency_key text not null check (length(idempotency_key) > 0),
        payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text not null check (length(round_id) > 0),
        game_id text not null check (length(game_id) > 0),
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(38,2) not null check (amount > 0),
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        result_balance_amount numeric(38,2),
        result_currency char(3),
        processed_at timestamptz,
        created_at timestamptz not null,
        pending_attempts integer not null default 0 check (pending_attempts >= 0),
        next_attempt_at timestamptz,
        constraint wager_provider_idempotency_unique unique (provider_id, idempotency_key),
        constraint wager_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_id_wallet_currency_unique unique (id, wallet_id, currency),
        constraint wager_wallet_player_currency_fk foreign key (wallet_id, player_id, currency)
          references wallets (id, player_id, currency) on delete restrict,
        constraint wager_reference_fk foreign key (reference_transaction_id)
          references wager_transactions (id) on delete restrict,
        constraint wager_result_pair_check check ((result_balance_amount is null) = (result_currency is null)),
        constraint wager_reference_state_check check (
          (reference_transaction_id is null or reference_external_transaction_id is not null)
          and (status <> 'PENDING_REFERENCE' or (kind in ('REFUND', 'ROLLBACK')
            and reference_external_transaction_id is not null and reference_transaction_id is null))
        ),
        constraint wager_opening_internal_check check (
          kind <> 'OPENING' or (provider_id = '__internal__' and status = 'PROCESSED'
            and result_balance_amount is not null and result_currency = currency)
        ),
        constraint wager_result_nonnegative_check check (result_balance_amount is null or result_balance_amount >= 0),
        constraint wager_failure_status_check check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null))
      );

      create index wager_pending_reference_due_idx on wager_transactions (next_attempt_at, created_at)
        where status = 'PENDING_REFERENCE';
      create unique index wager_one_processed_reversal_per_kind_idx
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK') and reference_transaction_id is not null;

      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(38,2) not null check (amount > 0),
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance_before numeric(38,2) not null check (balance_before >= 0),
        balance_after numeric(38,2) not null check (balance_after >= 0),
        created_at timestamptz not null,
        constraint ledger_wallet_transaction_unique unique (wallet_id, transaction_id),
        constraint ledger_transaction_wallet_currency_fk foreign key (transaction_id, wallet_id, currency)
          references wager_transactions (id, wallet_id, currency) on delete restrict,
        constraint ledger_balance_arithmetic_check check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );
      create function reject_wallet_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only' using errcode = '55000';
      end;
      $$;
      create trigger wallet_ledger_append_only before update or delete on wallet_ledger_entries
        for each row execute function reject_wallet_ledger_mutation();

      create table inbox_messages (
        consumer_name text not null check (length(consumer_name) > 0),
        message_id text not null check (length(message_id) > 0),
        payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );

      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null check (length(event_type) > 0),
        payload jsonb not null,
        occurred_at timestamptz not null,
        published_at timestamptz,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        claimed_by text,
        locked_until timestamptz,
        constraint outbox_lease_pair_check check ((claimed_by is null) = (locked_until is null))
      );
      create index outbox_due_idx on outbox_messages (next_attempt_at, occurred_at, id)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table if exists outbox_messages;
      drop table if exists inbox_messages;
      drop trigger if exists wallet_ledger_append_only on wallet_ledger_entries;
      drop function if exists reject_wallet_ledger_mutation();
      drop table if exists wallet_ledger_entries;
      drop table if exists wager_transactions;
      drop table if exists wallets;
    `);
  }
}
