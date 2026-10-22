import { Migration } from '@mikro-orm/migrations';

/** Adds child-side indexes for wallet, reference, and ledger foreign-key checks. */
export class Migration20261022110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create index wager_wallet_fk_idx on wager_transactions (wallet_id);
      create index wager_reference_fk_idx on wager_transactions (reference_transaction_id)
        where reference_transaction_id is not null;
      create index ledger_transaction_fk_idx on wallet_ledger_entries (transaction_id);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index ledger_transaction_fk_idx;
      drop index wager_reference_fk_idx;
      drop index wager_wallet_fk_idx;
    `);
  }
}
