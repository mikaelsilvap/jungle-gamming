import { Migration } from '@mikro-orm/migrations';

/** Preserves the original failure code when a pending wager later reaches a terminal state. */
export class Migration20261022140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions add column response_snapshot_failure_code text;
      update wager_transactions set response_snapshot_failure_code = failure_code
        where response_snapshot_status is not null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('alter table wager_transactions drop column if exists response_snapshot_failure_code;');
  }
}
