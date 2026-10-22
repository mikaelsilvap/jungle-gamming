import { Migration } from '@mikro-orm/migrations';

/** Preserves the original HTTP response when a pending wager later resolves. */
export class Migration20261022130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column response_snapshot_status text,
        add column response_snapshot_balance_amount numeric(38,2),
        add column response_snapshot_currency char(3);

      update wager_transactions
        set response_snapshot_status = status,
            response_snapshot_balance_amount = result_balance_amount,
            response_snapshot_currency = result_currency
        where result_balance_amount is not null and result_currency is not null;

      alter table wager_transactions
        add constraint wager_response_snapshot_pair_check check (
          (response_snapshot_status is null and response_snapshot_balance_amount is null and response_snapshot_currency is null)
          or (response_snapshot_status is not null and response_snapshot_balance_amount is not null and response_snapshot_currency is not null)
        );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table wager_transactions drop constraint if exists wager_response_snapshot_pair_check;
      alter table wager_transactions drop column if exists response_snapshot_currency;
      alter table wager_transactions drop column if exists response_snapshot_balance_amount;
      alter table wager_transactions drop column if exists response_snapshot_status;
    `);
  }
}
