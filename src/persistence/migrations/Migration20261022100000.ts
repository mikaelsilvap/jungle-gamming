import { Migration } from '@mikro-orm/migrations';

/** Adds stable ledger pagination and prevents bulk truncation of the audit ledger. */
export class Migration20261022100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      drop trigger wallet_ledger_append_only on wallet_ledger_entries;
      create trigger wallet_ledger_append_only before update or delete or truncate on wallet_ledger_entries
        for each statement execute function reject_wallet_ledger_mutation();
      create index if not exists wallet_ledger_wallet_cursor_idx on wallet_ledger_entries (wallet_id, created_at desc, id desc);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger wallet_ledger_append_only on wallet_ledger_entries;
      create trigger wallet_ledger_append_only before update or delete on wallet_ledger_entries
        for each row execute function reject_wallet_ledger_mutation();
      drop index wallet_ledger_wallet_cursor_idx;
    `);
  }
}
