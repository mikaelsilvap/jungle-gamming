import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain';
import { InboxMessageRecord, OutboxMessageRecord, WalletLedgerEntryRecord, WalletRecord, WagerTransactionRecord } from '../../src/persistence/entities';
import { createOrm } from '../../src/persistence/orm';
import { WalletPostgresAdapter } from '../../src/persistence/wallet-postgres.adapter';
import {
  rehydrateInboxMessage,
  rehydrateLedgerEntry,
  rehydrateOutboxMessage,
  rehydrateWallet,
  rehydrateWagerTransaction,
} from '../../src/persistence/rehydration';
import { WalletOpeningService } from '../../src/wallets/wallet-opening.service';

const testDatabaseName = process.env.TEST_DATABASE_NAME ?? 'wagering_phase2_test';
let orm: Awaited<ReturnType<typeof createOrm>>;
let wallets: WalletOpeningService;

function id(): string { return randomUUID(); }
function hash(): string { return 'a'.repeat(64); }

async function insertWager(props: {
  walletId: string; playerId: string; kind: string; externalId: string; key?: string;
  status?: string; referenceId?: string; referenceExternalId?: string;
}): Promise<string> {
  const transactionId = id();
  await orm.em.getConnection().execute(
    `insert into wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
      round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
      status, failure_code, created_at, pending_attempts
    ) values (?, 'provider-test', ?, ?, ?, ?, ?, 'round-test', 'game-test', ?, '1.00', 'BRL', ?, ?, ?, ?, now(), 0)`,
    [transactionId, props.externalId, props.key ?? `key:${props.externalId}`, hash(), props.walletId,
      props.playerId, props.kind, props.referenceExternalId ?? null, props.referenceId ?? null, props.status ?? 'PROCESSED',
      props.status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null],
  );
  return transactionId;
}

beforeAll(async () => {
  orm = await createOrm();
  const [db] = await orm.em.getConnection().execute<Array<{ name: string }>>('select current_database() as name');
  if (db?.name !== testDatabaseName) {
    await orm.close(true);
    throw new Error(`Refusing integration tests against non-disposable database ${db?.name}; expected ${testDatabaseName}.`);
  }
  await orm.migrator.up();
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
  wallets = new WalletOpeningService(new WalletPostgresAdapter(orm));
});

afterAll(async () => {
  if (orm) await orm.close(true);
});

describe('PostgreSQL persistence phase 2', () => {
  test('applies reversible migrations and supports repeated up/down/up', async () => {
    const [tables] = await orm.em.getConnection().execute<Array<{ count: string }>>(
      `select count(*)::text as count from information_schema.tables where table_schema = 'public'
       and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages')`);
    expect(tables?.count).toBe('5');
    const [indexes] = await orm.em.getConnection().execute<Array<{ count: string }>>(
      `select count(*)::text as count from pg_indexes where schemaname = 'public' and indexname in
        ('wallet_ledger_wallet_cursor_idx', 'wager_wallet_fk_idx', 'wager_reference_fk_idx', 'ledger_transaction_fk_idx')`);
    expect(indexes?.count).toBe('4');
  });

  test('opens a zero-balance wallet without synthetic financial rows', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    const [counts] = await orm.em.getConnection().execute<Array<{ wagers: string; entries: string }>>(
      `select (select count(*) from wager_transactions where wallet_id = ?)::text as wagers,
        (select count(*) from wallet_ledger_entries where wallet_id = ?)::text as entries`, [wallet.id, wallet.id]);
    expect(wallet.balance.amount).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(counts).toEqual({ wagers: '0', entries: '0' });
  });

  test('rejects amounts that cannot fit NUMERIC(38,2) before opening a wallet', async () => {
    const playerId = id();
    await expect(wallets.open({ playerId, initialBalance: { amount: '1000000000000000000000000000000000000.00', currency: 'BRL' } }))
      .rejects.toThrow('NUMERIC(38,2)');
    const [count] = await orm.em.getConnection().execute<Array<{ count: string }>>(
      'select count(*)::text as count from wallets where player_id = ?', [playerId]);
    expect(count?.count).toBe('0');
  });

  test('stores a positive opening, an OPENING transaction and one exact CREDIT ledger entry', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '1234567890123456789012345678901234.56', currency: 'BRL' } });
    expect(wallet.balance.amount).toBe('1234567890123456789012345678901234.56');
    expect(wallet.version).toBe(1);
    const [transaction] = await orm.em.getConnection().execute<Array<{ kind: string; status: string; amount: string; result_balance_amount: string }>>(
      `select kind, status, amount::text as amount, result_balance_amount::text as result_balance_amount
       from wager_transactions where wallet_id = ?`, [wallet.id]);
    const [entry] = await orm.em.getConnection().execute<Array<{
      direction: string; amount: string; balance_before: string; balance_after: string;
    }>>(
      `select direction, amount::text as amount, balance_before::text as balance_before, balance_after::text as balance_after
       from wallet_ledger_entries where wallet_id = ?`, [wallet.id]);
    expect(transaction).toEqual({
      kind: 'OPENING', status: 'PROCESSED', amount: wallet.balance.amount, result_balance_amount: wallet.balance.amount,
    });
    expect(entry).toEqual({ direction: 'CREDIT', amount: wallet.balance.amount, balance_before: '0.00', balance_after: wallet.balance.amount });

    const entityManager = orm.em.fork();
    const walletEntity = await entityManager.findOneOrFail(WalletRecord, { id: wallet.id });
    expect(rehydrateWallet(walletEntity).balance.toJSON()).toEqual(wallet.balance);
    const transactionEntity = await entityManager.findOneOrFail(WagerTransactionRecord, { walletId: wallet.id });
    const transactionDomain = rehydrateWagerTransaction(transactionEntity);
    expect(transactionDomain.kind).toBe(WagerTransactionKind.Opening);
    expect(transactionDomain.status).toBe(WagerTransactionStatus.Processed);
    const ledgerEntity = await entityManager.findOneOrFail(WalletLedgerEntryRecord, { walletId: wallet.id });
    expect(rehydrateLedgerEntry(ledgerEntity).isBalanced()).toBe(true);
  });

  test('enforces player and currency uniqueness under concurrent wallet openings', async () => {
    const playerId = id();
    const outcomes = await Promise.allSettled([
      wallets.open({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } }),
      wallets.open({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const [count] = await orm.em.getConnection().execute<Array<{ count: string }>>(
      'select count(*)::text as count from wallets where player_id = ? and currency = ?', [playerId, 'BRL']);
    expect(count?.count).toBe('1');
    const otherCurrency = await wallets.open({ playerId, initialBalance: { amount: '0.00', currency: 'USD' } });
    expect(otherCurrency.playerId).toBe(playerId);
  });

  test('rolls back wallet and opening rows when a ledger insert fails in PostgreSQL', async () => {
    const playerId = id();
    await orm.em.getConnection().execute(`
      create function test_reject_ledger_insert() returns trigger language plpgsql as $$
      begin raise exception 'forced integration failure'; end; $$;
      create trigger test_reject_ledger_insert before insert on wallet_ledger_entries
        for each row execute function test_reject_ledger_insert();
    `);
    try {
      await expect(wallets.open({ playerId, initialBalance: { amount: '5.25', currency: 'BRL' } })).rejects.toThrow();
    } finally {
      await orm.em.getConnection().execute(`drop trigger test_reject_ledger_insert on wallet_ledger_entries;
        drop function test_reject_ledger_insert();`);
    }
    const [counts] = await orm.em.getConnection().execute<Array<{ wallets: string; wagers: string; entries: string }>>(
      `select (select count(*) from wallets where player_id = ?)::text as wallets,
        (select count(*) from wager_transactions where player_id = ?)::text as wagers,
        (select count(*) from wallet_ledger_entries where wallet_id in (select id from wallets where player_id = ?))::text as entries`,
      [playerId, playerId, playerId]);
    expect(counts).toEqual({ wallets: '0', wagers: '0', entries: '0' });
  });

  test('database rejects a negative balance and duplicate ledger operations', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '1.00', currency: 'BRL' } });
    const [entry] = await orm.em.getConnection().execute<Array<{ id: string; transaction_id: string; currency: string }>>(
      'select id, transaction_id, currency from wallet_ledger_entries where wallet_id = ?', [wallet.id]);
    expect(entry).toBeDefined();
    await expect(orm.em.getConnection().execute('update wallets set balance_amount = -1 where id = ?', [wallet.id])).rejects.toThrow();
    await expect(orm.em.getConnection().execute(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at) values (?, ?, ?, 'CREDIT', '1.00', 'BRL', '0.00', '1.00', now())`,
      [id(), wallet.id, entry!.transaction_id],
    )).rejects.toThrow();

    const invalidMathTransactionId = await insertWager({ walletId: wallet.id, playerId: wallet.playerId,
      kind: 'WIN', externalId: 'invalid-ledger-math' });
    await expect(orm.em.getConnection().execute(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at) values (?, ?, ?, 'CREDIT', '1.00', 'BRL', '0.00', '2.00', now())`,
      [id(), wallet.id, invalidMathTransactionId],
    )).rejects.toThrow();
  });

  test('database rejects UPDATE, DELETE and TRUNCATE on ledger rows', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '2.00', currency: 'BRL' } });
    const [entry] = await orm.em.getConnection().execute<Array<{ id: string }>>(
      'select id from wallet_ledger_entries where wallet_id = ?', [wallet.id]);
    await expect(orm.em.getConnection().execute('update wallet_ledger_entries set amount = 9 where id = ?', [entry!.id])).rejects.toThrow();
    await expect(orm.em.getConnection().execute('delete from wallet_ledger_entries where id = ?', [entry!.id])).rejects.toThrow();
    await expect(orm.em.getConnection().execute('truncate wallet_ledger_entries')).rejects.toThrow();
    const [remaining] = await orm.em.getConnection().execute<Array<{ count: string }>>(
      'select count(*)::text as count from wallet_ledger_entries where id = ?', [entry!.id]);
    expect(remaining?.count).toBe('1');
  });

  test('enforces one processed reversal per reference and kind persistently', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '10.00', currency: 'BRL' } });
    const betId = await insertWager({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', externalId: 'bet-ref' });
    await insertWager({ walletId: wallet.id, playerId: wallet.playerId, kind: 'REFUND', externalId: 'refund-one',
      referenceId: betId, referenceExternalId: 'bet-ref' });
    await expect(insertWager({ walletId: wallet.id, playerId: wallet.playerId, kind: 'REFUND', externalId: 'refund-two',
      referenceId: betId, referenceExternalId: 'bet-ref' })).rejects.toThrow();
    const rollbackId = await insertWager({ walletId: wallet.id, playerId: wallet.playerId, kind: 'ROLLBACK', externalId: 'rollback-one',
      referenceId: betId, referenceExternalId: 'bet-ref' });
    expect(typeof rollbackId).toBe('string');
  });

  test('maps Inbox and Outbox records and rehydrates domain states without monetary conversion', async () => {
    const consumerName = 'phase2-test';
    const messageId = id();
    const outboxId = id();
    await orm.em.getConnection().execute(
      'insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, now())',
      [consumerName, messageId, hash()]);
    await orm.em.getConnection().execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values (?, ?, 'TestEvent', ?::jsonb, now(), 0)`, [outboxId, id(), JSON.stringify({ amount: '999999999999999999999999.99' })]);
    const entityManager = orm.em.fork();
    const inboxEntity = await entityManager.findOneOrFail(InboxMessageRecord, { messageId, consumerName });
    const outboxEntity = await entityManager.findOneOrFail(OutboxMessageRecord, { id: outboxId });
    expect(rehydrateInboxMessage(inboxEntity).isProcessed()).toBe(false);
    expect(rehydrateOutboxMessage(outboxEntity).payload).toEqual({ amount: '999999999999999999999999.99' });
    expect(Money.from({ amount: outboxEntity.payload.amount as string, currency: 'BRL' }).toJSON().amount)
      .toBe('999999999999999999999999.99');
  });

  test('wallet read, ledger cursor and reconciliation use exact decimal values', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '25.10', currency: 'BRL' } });
    expect((await wallets.get(wallet.id))?.balance.amount).toBe('25.10');
    const creditId = await insertWager({ walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN', externalId: 'cursor-credit' });
    const debitId = await insertWager({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', externalId: 'cursor-debit' });
    const creditAt = new Date(Date.now() + 1_000);
    const debitAt = new Date(Date.now() + 2_000);
    await orm.em.getConnection().execute(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at) values (?, ?, ?, 'CREDIT', '1.00', 'BRL', '25.10', '26.10', ?)`,
      [id(), wallet.id, creditId, creditAt]);
    await orm.em.getConnection().execute(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at) values (?, ?, ?, 'DEBIT', '1.00', 'BRL', '26.10', '25.10', ?)`,
      [id(), wallet.id, debitId, debitAt]);
    const firstPage = await wallets.ledger(wallet.id, undefined, 1);
    expect(firstPage?.entries[0]?.transactionId).toBe(debitId);
    expect(typeof firstPage?.nextCursor).toBe('string');
    const secondPage = await wallets.ledger(wallet.id, firstPage!.nextCursor!, 1);
    expect(secondPage?.entries[0]?.transactionId).toBe(creditId);
    expect(secondPage?.entries[0]?.money).toEqual({ amount: '1.00', currency: 'BRL' });
    const reconciliation = await wallets.reconcile(wallet.id);
    expect(reconciliation).toMatchObject({
      storedBalance: { amount: '25.10', currency: 'BRL' }, calculatedBalance: { amount: '25.10', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 3,
    });
  });
});
