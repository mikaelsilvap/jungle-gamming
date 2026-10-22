import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FailureCode, Money, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain';
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
import { ProcessWagerInput, ProcessWagerService } from '../../src/wagering/process-wager.service';
import { PendingReferenceWorker } from '../../src/wagering/pending-reference.worker';

const testDatabaseName = process.env.TEST_DATABASE_NAME ?? 'wagering_phase2_test';
let orm: Awaited<ReturnType<typeof createOrm>>;
let wallets: WalletOpeningService;
let wagers: ProcessWagerService;

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
  wagers = new ProcessWagerService(orm);
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
    const [openingEvents] = await orm.em.getConnection().execute<Array<{ count: string }>>(
      `select count(*)::text as count from outbox_messages where aggregate_id = ? and event_type in ('WagerTransactionProcessed','WalletBalanceChanged')`, [wallet.id]);
    expect(openingEvents?.count).toBe('2');
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

describe('PostgreSQL wagering phase 3', () => {
  async function request(walletId: string, playerId: string, overrides: Partial<ProcessWagerInput> = {}): Promise<ProcessWagerInput> {
    return {
      providerId: `provider-${playerId}`, externalTransactionId: id(), playerId, walletId,
      roundId: 'round-phase3', gameId: 'game-phase3', kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' }, ...overrides,
    };
  }

  test('processes one BET among 50 concurrent identical submissions and replays the original balance', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = await request(wallet.id, playerId);
    const key = `same:${id()}`;
    const results = await Promise.all(Array.from({ length: 50 }, () => wagers.process(input, key)));
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    const first = results.find((result) => !result.idempotentReplay)!;
    expect(first.balance.amount).toBe('90.00');
    await wagers.process(await request(wallet.id, playerId, {
      kind: WagerTransactionKind.Win, externalTransactionId: id(), money: { amount: '5.00', currency: 'BRL' },
    }), `later:${id()}`);
    const replay = await wagers.process(input, key);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('90.00');
    const [counts] = await orm.em.getConnection().execute<Array<{ transactions: string; entries: string; events: string }>>(
      `select (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET')::text as transactions,
       (select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT')::text as entries,
       (select count(*) from outbox_messages where aggregate_id = ? and event_type in ('WagerTransactionProcessed','WalletBalanceChanged'))::text as events`,
      [wallet.id, wallet.id, wallet.id]);
    expect(counts).toEqual({ transactions: '1', entries: '1', events: '6' });
  });

  test('serializes competing BETs on one PostgreSQL wallet lock', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const [first, second] = await Promise.all([
      request(wallet.id, playerId, { money: { amount: '80.00', currency: 'BRL' } }),
      request(wallet.id, playerId, { money: { amount: '80.00', currency: 'BRL' } }),
    ]);
    const outcomes = await Promise.all([
      wagers.process(first, `key:${id()}`), wagers.process(second, `key:${id()}`),
    ]);
    expect(outcomes.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'REJECTED' && result.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    expect((await wallets.get(wallet.id))?.balance.amount).toBe('20.00');
    const [entries] = await orm.em.getConnection().execute<Array<{ count: string }>>(
      `select count(*)::text as count from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [wallet.id]);
    expect(entries?.count).toBe('1');
  });

  test('conflicting idempotency payload has no second financial side effect', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = await request(wallet.id, playerId);
    const key = `conflict:${id()}`;
    await wagers.process(input, key);
    await expect(wagers.process({ ...input, money: { amount: '11.00', currency: 'BRL' } }, key)).rejects.toThrow('different payload');
    expect((await wallets.get(wallet.id))?.balance.amount).toBe('90.00');
  });

  test('persists missing reversal references as pending without ledger or balance events', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = await request(wallet.id, playerId, {
      kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'not-arrived',
      money: { amount: '10.00', currency: 'BRL' },
    });
    const result = await wagers.process(input, `pending:${id()}`);
    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    const [counts] = await orm.em.getConnection().execute<Array<{ entries: string; pending: string; pendingEvents: string; balanceEvents: string }>>(
      `select (select count(*) from wallet_ledger_entries where transaction_id = ?)::text as entries,
       (select count(*) from wager_transactions where id = ? and status = 'PENDING_REFERENCE')::text as pending,
       (select count(*) from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionPendingReference')::text as "pendingEvents",
       (select count(*) from outbox_messages where aggregate_id = ? and event_type = 'WalletBalanceChanged')::text as "balanceEvents"`,
      [result.transactionId, result.transactionId, wallet.id, wallet.id]);
    expect(counts).toEqual({ entries: '0', pending: '1', pendingEvents: '1', balanceEvents: '1' });
  });

  test('processes BET, REFUND and ROLLBACK with durable single-reversal semantics', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const betInput = await request(wallet.id, playerId, { money: { amount: '10.00', currency: 'BRL' } });
    const bet = await wagers.process(betInput, `bet:${id()}`);
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    const refundInput = await request(wallet.id, playerId, {
      kind: WagerTransactionKind.Refund, referenceExternalTransactionId: betInput.externalTransactionId,
      money: { amount: '10.00', currency: 'BRL' },
    });
    const refund = await wagers.process(refundInput, `refund:${id()}`);
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    const rollbackInput = await request(wallet.id, playerId, {
      kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: refundInput.externalTransactionId,
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect((await wagers.process(rollbackInput, `rollback:${id()}`)).status).toBe(WagerTransactionStatus.Processed);
    const repeatedRollback = await wagers.process({ ...rollbackInput, externalTransactionId: id() }, `rollback-again:${id()}`);
    expect(repeatedRollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(repeatedRollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    const duplicateRefundInput = { ...refundInput, externalTransactionId: id() };
    const duplicateRefund = await wagers.process(duplicateRefundInput, `refund-duplicate:${id()}`);
    expect(duplicateRefund.status).toBe(WagerTransactionStatus.Rejected);
    expect(duplicateRefund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    const page = await wallets.ledger(wallet.id, undefined, 20);
    expect(page?.entries.map((entry) => (entry as { direction: string }).direction)).toEqual(['DEBIT', 'CREDIT', 'DEBIT', 'CREDIT']);
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('supports ROLLBACK of processed BET, WIN, and REFUND directions', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const submit = async (kind: WagerTransactionKind, amount: string, referenceExternalTransactionId?: string) => {
      const input = await request(wallet.id, playerId, {
        kind, money: { amount, currency: 'BRL' },
        ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
      });
      return { input, result: await wagers.process(input, `${kind}:${id()}`) };
    };
    const bet = await submit(WagerTransactionKind.Bet, '10.00');
    expect(bet.result.status).toBe(WagerTransactionStatus.Processed);
    expect((await submit(WagerTransactionKind.Rollback, '10.00', bet.input.externalTransactionId)).result.status)
      .toBe(WagerTransactionStatus.Processed);
    const win = await submit(WagerTransactionKind.Win, '5.00');
    expect((await submit(WagerTransactionKind.Rollback, '5.00', win.input.externalTransactionId)).result.status)
      .toBe(WagerTransactionStatus.Processed);
    const secondBet = await submit(WagerTransactionKind.Bet, '10.00');
    const refund = await submit(WagerTransactionKind.Refund, '10.00', secondBet.input.externalTransactionId);
    expect(refund.result.status).toBe(WagerTransactionStatus.Processed);
    expect((await submit(WagerTransactionKind.Rollback, '10.00', refund.input.externalTransactionId)).result.status)
      .toBe(WagerTransactionStatus.Processed);
    expect((await wallets.get(wallet.id))?.balance.amount).toBe('90.00');
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('LOSS and rejected operations create durable results without ledger or balance-change events', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    const loss = await wagers.process(await request(wallet.id, playerId, { kind: WagerTransactionKind.Loss }), `loss:${id()}`);
    const rejected = await wagers.process(await request(wallet.id, playerId, { money: { amount: '2.00', currency: 'BRL' } }), `bet-reject:${id()}`);
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await wallets.get(wallet.id))?.balance.amount).toBe('1.00');
    const [counts] = await orm.em.getConnection().execute<Array<{ entries: string; balanceEvents: string; rejectedEvents: string }>>(
      `select (select count(*) from wallet_ledger_entries where wallet_id = ?)::text as entries,
       (select count(*) from outbox_messages where aggregate_id = ? and event_type = 'WalletBalanceChanged')::text as "balanceEvents",
       (select count(*) from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected')::text as "rejectedEvents"`,
      [wallet.id, wallet.id, wallet.id]);
    expect(counts).toEqual({ entries: '1', balanceEvents: '1', rejectedEvents: '1' });
  });

  test('rolls transaction, balance, ledger and outbox back together when ledger insertion fails', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '20.00', currency: 'BRL' } });
    await orm.em.getConnection().execute(`create function test_phase3_reject_ledger() returns trigger language plpgsql as $$
      begin if new.wallet_id = '${wallet.id}'::uuid then raise exception 'phase3 forced failure'; end if; return new; end; $$`);
    await orm.em.getConnection().execute(`create trigger test_phase3_reject_ledger before insert on wallet_ledger_entries for each row execute function test_phase3_reject_ledger()`);
    try {
      await expect(wagers.process(await request(wallet.id, playerId), `rollback:${id()}`)).rejects.toThrow();
    } finally {
      await orm.em.getConnection().execute('drop trigger test_phase3_reject_ledger on wallet_ledger_entries');
      await orm.em.getConnection().execute('drop function test_phase3_reject_ledger()');
    }
    const [counts] = await orm.em.getConnection().execute<Array<{ balance: string; wagers: string; entries: string; events: string }>>(
      `select (select balance_amount::text from wallets where id = ?) as balance,
       (select count(*) from wager_transactions where wallet_id = ? and external_transaction_id <> 'opening:' || ?)::text as wagers,
       (select count(*) from wallet_ledger_entries where wallet_id = ?)::text as entries,
       (select count(*) from outbox_messages where aggregate_id = ?)::text as events`,
      [wallet.id, wallet.id, wallet.id, wallet.id, wallet.id]);
    expect(counts).toEqual({ balance: '20.00', wagers: '0', entries: '1', events: '2' });
  });
});

describe('PostgreSQL pending-reference worker phase 4', () => {
  function betInput(walletId: string, playerId: string, overrides: Partial<ProcessWagerInput> = {}): ProcessWagerInput {
    return {
      providerId: `provider-${playerId}`, externalTransactionId: id(), playerId, walletId,
      roundId: 'phase4-round', gameId: 'phase4-game', kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' }, ...overrides,
    };
  }

  async function pendingOperation(kind: WagerTransactionKind, playerId: string, walletId: string, referenceId: string, providerId: string, amount = '10.00') {
    const input: ProcessWagerInput = {
      providerId, externalTransactionId: id(), playerId, walletId, roundId: 'phase4-round', gameId: 'phase4-game',
      kind, money: { amount, currency: 'BRL' }, referenceExternalTransactionId: referenceId,
    };
    const key = `pending:${id()}`;
    return { input, key, result: await wagers.process(input, key) };
  }

  async function makeDue(transactionId: string): Promise<void> {
    await orm.em.getConnection().execute(
      `update wager_transactions set next_attempt_at = now() - interval '1 second' where id = ?`, [transactionId]);
  }

  test('resolves REFUND that arrived before its BET and preserves one pending event', async () => {
    const playerId = id();
    const providerId = `provider-${playerId}`;
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const pending = await pendingOperation(WagerTransactionKind.Refund, playerId, wallet.id, 'late-bet', providerId);
    expect(pending.result.status).toBe(WagerTransactionStatus.PendingReference);
    const bet = betInput(wallet.id, playerId, {
      providerId, externalTransactionId: 'late-bet', roundId: pending.input.roundId,
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect((await wagers.process(bet, `late-bet-key:${id()}`)).status).toBe(WagerTransactionStatus.Processed);
    const interveningBet = betInput(wallet.id, playerId, {
      providerId, externalTransactionId: 'intervening-bet', roundId: pending.input.roundId,
      money: { amount: '5.00', currency: 'BRL' },
    });
    expect((await wagers.process(interveningBet, `intervening-key:${id()}`)).status).toBe(WagerTransactionStatus.Processed);
    await makeDue(pending.result.transactionId);
    const worker = new PendingReferenceWorker(wagers, () => new Date());
    const summary = await worker.runOnce();
    expect(summary.processed).toBe(1);
    const replay = await wagers.process(pending.input, pending.key);
    expect(replay.status).toBe(WagerTransactionStatus.PendingReference);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('100.00');
    const current = await wagers.getById(pending.result.transactionId);
    expect(current?.status).toBe(WagerTransactionStatus.Processed);
    expect(current?.balance.amount).toBe('95.00');
    const [counts] = await orm.em.getConnection().execute<Array<{ entries: string; pendingEvents: string; processedEvents: string; balanceEvents: string }>>(
      `select (select count(*) from wallet_ledger_entries where transaction_id = ?)::text as entries,
       (select count(*) from outbox_messages where payload->'data'->>'transactionId' = ? and event_type = 'WagerTransactionPendingReference')::text as "pendingEvents",
       (select count(*) from outbox_messages where payload->'data'->>'transactionId' = ? and event_type = 'WagerTransactionProcessed')::text as "processedEvents",
       (select count(*) from outbox_messages where payload->'data'->>'transactionId' = ? and event_type = 'WalletBalanceChanged')::text as "balanceEvents"`,
      [pending.result.transactionId, pending.result.transactionId, pending.result.transactionId, pending.result.transactionId]);
    expect(counts).toEqual({ entries: '1', pendingEvents: '1', processedEvents: '1', balanceEvents: '1' });
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('resolves ROLLBACK after a reference is initially unprocessed, without retry event duplication', async () => {
    const playerId = id();
    const providerId = 'provider-test';
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const referenceId = await insertWager({ walletId: wallet.id, playerId, kind: 'BET', externalId: `not-yet-${id()}`, status: 'PENDING' });
    await orm.em.getConnection().execute(`update wager_transactions set round_id = 'phase4-round', game_id = 'phase4-game' where id = ?`, [referenceId]);
    const [reference] = await orm.em.getConnection().execute<Array<{ external_transaction_id: string }>>(
      `select external_transaction_id from wager_transactions where id = ?`, [referenceId]);
    const pending = await pendingOperation(WagerTransactionKind.Rollback, playerId, wallet.id, reference!.external_transaction_id, providerId, '1.00');
    expect(pending.result.status).toBe(WagerTransactionStatus.PendingReference);
    await makeDue(pending.result.transactionId);
    const firstWorker = new PendingReferenceWorker(wagers, () => new Date());
    expect((await firstWorker.runOnce()).rescheduled).toBe(1);
    const [afterRetry] = await orm.em.getConnection().execute<Array<{ attempts: number; pendingEvents: string; entries: string }>>(
      `select pending_attempts as attempts,
        (select count(*) from outbox_messages where payload->'data'->>'transactionId' = ? and event_type = 'WagerTransactionPendingReference')::text as "pendingEvents",
        (select count(*) from wallet_ledger_entries where transaction_id = ?)::text as entries
       from wager_transactions where id = ?`,
      [pending.result.transactionId, pending.result.transactionId, pending.result.transactionId]);
    expect(afterRetry).toEqual({ attempts: 1, pendingEvents: '1', entries: '0' });

    const [lockedWallet] = await orm.em.getConnection().execute<Array<{ balance: string; version: number }>>(
      `select balance_amount::text as balance, version from wallets where id = ?`, [wallet.id]);
    const after = Money.from({ amount: lockedWallet!.balance, currency: 'BRL' }).subtract(Money.from({ amount: '1.00', currency: 'BRL' }));
    const processedAt = new Date();
    await orm.em.getConnection().execute(
      `update wallets set balance_amount = ?, version = version + 1, updated_at = ? where id = ?`,
      [after.toJSON().amount, processedAt, wallet.id]);
    await orm.em.getConnection().execute(
      `update wager_transactions set status = 'PROCESSED', processed_at = ?, result_balance_amount = ?, result_currency = 'BRL' where id = ?`,
      [processedAt, after.toJSON().amount, referenceId]);
    await orm.em.getConnection().execute(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'DEBIT', '1.00', 'BRL', ?, ?, ?)`,
      [id(), wallet.id, referenceId, lockedWallet!.balance, after.toJSON().amount, processedAt]);
    await orm.em.getConnection().execute(
      `update wager_transactions set next_attempt_at = now() - interval '1 second' where id = ?`, [pending.result.transactionId]);
    const restartedWorker = new PendingReferenceWorker(wagers, () => new Date());
    expect((await restartedWorker.runOnce()).processed).toBe(1);
    expect((await wagers.process(pending.input, pending.key)).status).toBe(WagerTransactionStatus.PendingReference);
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('rejects a late-arriving reference with mismatched identity and expires missing references auditably', async () => {
    const playerA = id();
    const walletA = await wallets.open({ playerId: playerA, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const providerId = `p-${id()}`;
    const pendingInvalid = await pendingOperation(WagerTransactionKind.Refund, playerA, walletA.id, 'wrong-owner-bet', providerId);
    const playerB = id();
    const walletB = await wallets.open({ playerId: playerB, initialBalance: { amount: '100.00', currency: 'BRL' } });
    await wagers.process(betInput(walletB.id, playerB, {
      providerId, externalTransactionId: 'wrong-owner-bet', roundId: pendingInvalid.input.roundId,
      money: { amount: '10.00', currency: 'BRL' },
    }), `wrong-ref:${id()}`);
    await makeDue(pendingInvalid.result.transactionId);
    const worker = new PendingReferenceWorker(wagers, () => new Date());
    expect((await worker.runOnce()).rejected).toBe(1);
    expect((await wagers.getById(pendingInvalid.result.transactionId))?.failureCode).toBe(FailureCode.ReferenceMismatch);

    const missing = await pendingOperation(WagerTransactionKind.Rollback, playerA, walletA.id, 'never-arrives', providerId);
    await orm.em.getConnection().execute(
      `update wager_transactions set reference_expires_at = now() - interval '1 second', next_attempt_at = now() + interval '1 hour' where id = ?`,
      [missing.result.transactionId]);
    expect((await worker.runOnce()).rejected).toBe(1);
    expect((await wagers.getById(missing.result.transactionId))?.failureCode).toBe(FailureCode.ReferenceExpired);
    const [events] = await orm.em.getConnection().execute<Array<{ pending: string; rejected: string; ledger: string }>>(
      `select (select count(*) from outbox_messages where payload->'data'->>'transactionId' = ? and event_type = 'WagerTransactionPendingReference')::text as pending,
        (select count(*) from outbox_messages where payload->'data'->>'transactionId' = ? and event_type = 'WagerTransactionRejected')::text as rejected,
        (select count(*) from wallet_ledger_entries where transaction_id = ?)::text as ledger`,
      [missing.result.transactionId, missing.result.transactionId, missing.result.transactionId]);
    expect(events).toEqual({ pending: '1', rejected: '1', ledger: '0' });
  });

  test('leases prevent two workers claiming one row and expired leases recover after worker restart', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const pending = await pendingOperation(WagerTransactionKind.Refund, playerId, wallet.id, 'lease-bet', `p-${id()}`);
    await makeDue(pending.result.transactionId);
    const now = new Date();
    const claims = await Promise.all([
      wagers.claimPending('worker-one', now, 1_000, 10),
      wagers.claimPending('worker-two', now, 1_000, 10),
    ]);
    expect(claims.flat()).toEqual([pending.result.transactionId]);
    const deadWorkerClaim = claims[0]!.length ? 'worker-one' : 'worker-two';
    expect(await wagers.resumePending(pending.result.transactionId, deadWorkerClaim === 'worker-one' ? 'worker-two' : 'worker-one', now))
      .toBe('skipped');
    expect(await wagers.claimPending('worker-after-restart', new Date(now.getTime() + 1_001), 1_000, 10))
      .toEqual([pending.result.transactionId]);
    expect(await wagers.resumePending(pending.result.transactionId, 'worker-after-restart', new Date(now.getTime() + 1_001)))
      .toBe('rescheduled');
    const [row] = await orm.em.getConnection().execute<Array<{ attempts: number }>>(
      `select pending_attempts as attempts from wager_transactions where id = ?`, [pending.result.transactionId]);
    expect(row?.attempts).toBe(1);
  });
});
