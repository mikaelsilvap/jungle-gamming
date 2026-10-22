import { Migration } from '@mikro-orm/migrations';

/** Adds durable reference retry deadlines and an expiring worker claim. */
export class Migration20261022120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column reference_expires_at timestamptz,
        add column claimed_by text,
        add column locked_until timestamptz;

      update wager_transactions
        set reference_expires_at = created_at + interval '24 hours',
            next_attempt_at = coalesce(next_attempt_at, created_at + interval '1 minute')
        where status = 'PENDING_REFERENCE';

      alter table wager_transactions
        add constraint wager_pending_lease_pair_check check ((claimed_by is null) = (locked_until is null)),
        add constraint wager_pending_expiry_check check (status <> 'PENDING_REFERENCE' or reference_expires_at is not null);

      drop index if exists wager_pending_reference_due_idx;
      create index wager_pending_reference_due_idx
        on wager_transactions (next_attempt_at, reference_expires_at, created_at)
        where status = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index if exists wager_pending_reference_due_idx;
      create index wager_pending_reference_due_idx on wager_transactions (next_attempt_at, created_at)
        where status = 'PENDING_REFERENCE';
      alter table wager_transactions drop constraint if exists wager_pending_expiry_check;
      alter table wager_transactions drop constraint if exists wager_pending_lease_pair_check;
      alter table wager_transactions drop column if exists locked_until;
      alter table wager_transactions drop column if exists claimed_by;
      alter table wager_transactions drop column if exists reference_expires_at;
    `);
  }
}
