import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand,
  SendMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
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
import { ReferenceRetryPolicy } from '../../src/wagering/reference-retry-policy';
import { WagerSqsConsumer, createWagerSqsClient } from '../../src/messaging/wager-sqs-consumer';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';

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
    const originalReplay = await wagers.process(missing.input, missing.key);
    expect(originalReplay.status).toBe(WagerTransactionStatus.PendingReference);
    expect(originalReplay.failureCode).toBeUndefined();
    expect(originalReplay.balance.amount).toBe('100.00');
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

  test('rejects a pending reference with a stable code after the configured attempt limit', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const pending = await pendingOperation(WagerTransactionKind.Refund, playerId, wallet.id, 'attempt-limit-bet', `p-${id()}`);
    await orm.em.getConnection().execute(
      `update wager_transactions set next_attempt_at = now() - interval '1 second', reference_expires_at = now() + interval '1 hour' where id = ?`,
      [pending.result.transactionId]);
    const processor = new ProcessWagerService(orm, new ReferenceRetryPolicy({
      baseDelayMs: 1, maximumDelayMs: 10, timeToLiveMs: 3_600_000, maximumAttempts: 1,
    }));
    const worker = new PendingReferenceWorker(processor, () => new Date());
    expect((await worker.runOnce()).rejected).toBe(1);
    const result = await wagers.getById(pending.result.transactionId);
    expect(result?.status).toBe(WagerTransactionStatus.Rejected);
    expect(result?.failureCode).toBe(FailureCode.ReferenceRetryExhausted);
    const [counts] = await orm.em.getConnection().execute<Array<{ attempts: number; pendingEvents: string; rejectedEvents: string; ledger: string }>>(
      `select pending_attempts as attempts,
        (select count(*) from outbox_messages where payload->'data'->>'transactionId' = ? and event_type = 'WagerTransactionPendingReference')::text as "pendingEvents",
        (select count(*) from outbox_messages where payload->'data'->>'transactionId' = ? and event_type = 'WagerTransactionRejected')::text as "rejectedEvents",
        (select count(*) from wallet_ledger_entries where transaction_id = ?)::text as ledger
       from wager_transactions where id = ?`,
      [pending.result.transactionId, pending.result.transactionId, pending.result.transactionId, pending.result.transactionId]);
    expect(counts).toEqual({ attempts: 1, pendingEvents: '1', rejectedEvents: '1', ledger: '0' });
  });
});

describe('PostgreSQL and LocalStack SQS consumer phase 5', () => {
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
  const sqs = new SQSClient({ endpoint, region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const consumerName = 'phase5-integration-consumer-v1';
  let queueUrl = '';
  let dlqUrl = '';

  function request(walletId: string, playerId: string, overrides: Partial<ProcessWagerInput> = {}): ProcessWagerInput {
    return {
      providerId: `sqs-${playerId}`, externalTransactionId: id(), playerId, walletId,
      roundId: 'phase5-round', gameId: 'phase5-game', kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' }, ...overrides,
    };
  }

  function envelope(input: ProcessWagerInput, messageId = id(), idempotencyKey = `sqs-key:${id()}`) {
    return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: { ...input, idempotencyKey } };
  }

  async function send(body: unknown, messageGroupId = 'invalid-or-unassigned-group'): Promise<void> {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(body),
      MessageGroupId: messageGroupId, MessageDeduplicationId: id() }));
  }

  function consumer(waitTimeSeconds = 1, maxMessages = 10): WagerSqsConsumer {
    return new WagerSqsConsumer(wagers, sqs, { queueUrl, consumerName, visibilityTimeoutSeconds: 2,
      waitTimeSeconds, maxMessages, retryBaseSeconds: 1, retryMaximumSeconds: 2 });
  }

  async function rowFor(providerId: string, externalTransactionId: string): Promise<WagerTransactionRecord | undefined> {
    const [row] = await orm.em.getConnection().execute<WagerTransactionRecord[]>(
      `select ${'id, provider_id as "providerId", external_transaction_id as "externalTransactionId", status, failure_code as "failureCode"'}
       from wager_transactions where provider_id = ? and external_transaction_id = ?`, [providerId, externalTransactionId]);
    return row;
  }

  beforeEach(async () => {
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    if (dlqUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    const suffix = randomUUID().replaceAll('-', '');
    const dlqName = `wager-test-dlq-${suffix}.fifo`;
    const queueName = `wager-test-command-${suffix}.fifo`;
    dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: {
      FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '2',
    } }))).QueueUrl!;
    const [dlqAttributes] = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
      .then((result) => [result.Attributes]);
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: {
      FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '2',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqAttributes!.QueueArn, maxReceiveCount: '3' }),
    } }))).QueueUrl!;
  });

  afterAll(async () => {
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    if (dlqUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    sqs.destroy();
  });

  test('processes a real FIFO wager with atomic Inbox, ledger, and Outbox writes before ACK', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = request(wallet.id, playerId);
    const message = envelope(input);
    await send(message, wallet.id);
    expect(await consumer().runOnce()).toEqual({ received: 1, acknowledged: 1, inboxDuplicates: 0, deferred: 0 });
    const [inbox] = await orm.em.getConnection().execute<Array<{ processed_at: Date | null; payload_hash: string }>>(
      `select processed_at, payload_hash from inbox_messages where consumer_name = ? and message_id = ?`,
      [consumerName, message.messageId]);
    const [counts] = await orm.em.getConnection().execute<Array<{ wagers: string; ledger: string; outbox: string }>>(
      `select (select count(*) from wager_transactions where provider_id = ? and external_transaction_id = ?)::text as wagers,
        (select count(*) from wallet_ledger_entries where wallet_id = ?)::text as ledger,
        (select count(*) from outbox_messages where payload->'data'->>'transactionId' = (select id::text from wager_transactions where provider_id = ? and external_transaction_id = ?))::text as outbox`,
      [input.providerId, input.externalTransactionId, wallet.id, input.providerId, input.externalTransactionId]);
    expect(Number.isFinite(new Date(inbox!.processed_at!).getTime())).toBe(true);
    expect(inbox?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(counts).toEqual({ wagers: '1', ledger: '2', outbox: '2' });
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('deduplicates a repeated messageId and a repeated financial operation with different messageIds', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = request(wallet.id, playerId);
    const sameMessage = envelope(input);
    await send(sameMessage, wallet.id);
    await send(sameMessage, wallet.id);
    const duplicateStats = await consumer().runOnce();
    expect(duplicateStats).toEqual({ received: 2, acknowledged: 2, inboxDuplicates: 1, deferred: 0 });

    const secondInput = request(wallet.id, playerId);
    const first = envelope(secondInput, id(), 'same-business-operation');
    const second = envelope(secondInput, id(), 'same-business-operation');
    await send(first, wallet.id);
    await send(second, wallet.id);
    expect(await consumer().runOnce()).toEqual({ received: 2, acknowledged: 2, inboxDuplicates: 0, deferred: 0 });
    const [counts] = await orm.em.getConnection().execute<Array<{ inbox: string; wagers: string; ledger: string }>>(
      `select (select count(*) from inbox_messages where consumer_name = ? and message_id in (?, ?, ?, ?))::text as inbox,
        (select count(*) from wager_transactions where provider_id = ? and external_transaction_id = ?)::text as wagers,
        (select count(*) from wallet_ledger_entries where wallet_id = ?)::text as ledger`,
      [consumerName, sameMessage.messageId, first.messageId, second.messageId,
        'message-not-present', secondInput.providerId, secondInput.externalTransactionId, wallet.id]);
    expect(counts).toEqual({ inbox: '3', wagers: '1', ledger: '3' });
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('does not ACK a reused messageId with a divergent payload', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = request(wallet.id, playerId);
    const original = envelope(input);
    await send(original, wallet.id);
    expect((await consumer().runOnce()).acknowledged).toBe(1);
    const divergent = { ...original, data: { ...original.data, money: { amount: '11.00', currency: 'BRL' } } };
    await send(divergent, wallet.id);
    expect(await consumer().runOnce()).toEqual({ received: 1, acknowledged: 0, inboxDuplicates: 0, deferred: 1 });
    const [counts] = await orm.em.getConnection().execute<Array<{ inbox: string; ledger: string }>>(
      `select (select count(*) from inbox_messages where consumer_name = ? and message_id = ?)::text as inbox,
        (select count(*) from wallet_ledger_entries l join wager_transactions w on w.id = l.transaction_id
          where l.wallet_id = ? and w.kind <> 'OPENING')::text as ledger`, [consumerName, original.messageId, wallet.id]);
    expect(counts).toEqual({ inbox: '1', ledger: '1' });
  });

  test('ACKs a persisted insufficient-funds rejection without a ledger movement', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });
    const input = request(wallet.id, playerId, { money: { amount: '10.00', currency: 'BRL' } });
    await send(envelope(input), wallet.id);
    expect(await consumer().runOnce()).toEqual({ received: 1, acknowledged: 1, inboxDuplicates: 0, deferred: 0 });
    const row = await rowFor(input.providerId, input.externalTransactionId);
    expect(row?.status).toBe(WagerTransactionStatus.Rejected);
    expect(row?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('serializes same-wallet command messages in one FIFO group without overdraft', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const first = request(wallet.id, playerId, { money: { amount: '80.00', currency: 'BRL' } });
    const second = request(wallet.id, playerId, { money: { amount: '80.00', currency: 'BRL' } });
    await send(envelope(first), wallet.id);
    await send(envelope(second), wallet.id);
    expect(await consumer().runOnce()).toEqual({ received: 2, acknowledged: 2, inboxDuplicates: 0, deferred: 0 });
    const [rows] = await orm.em.getConnection().execute<Array<{ processed: string; rejected: string; balance: string; wagerLedger: string }>>(
      `select (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET' and status = 'PROCESSED')::text as processed,
        (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET' and status = 'REJECTED')::text as rejected,
        (select balance_amount::text from wallets where id = ?) as balance,
        (select count(*) from wallet_ledger_entries l join wager_transactions w on w.id = l.transaction_id where w.wallet_id = ? and w.kind = 'BET')::text as "wagerLedger"`,
      [wallet.id, wallet.id, wallet.id, wallet.id]);
    expect(rows).toEqual({ processed: '1', rejected: '1', balance: '20.00', wagerLedger: '1' });
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('allows separate wallet groups to advance independently across real FIFO messages', async () => {
    const playerA = id();
    const playerB = id();
    const walletA = await wallets.open({ playerId: playerA, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const walletB = await wallets.open({ playerId: playerB, initialBalance: { amount: '100.00', currency: 'BRL' } });
    await send(envelope(request(walletA.id, playerA)), walletA.id);
    await send(envelope(request(walletB.id, playerB)), walletB.id);
    expect(await consumer().runOnce()).toEqual({ received: 2, acknowledged: 2, inboxDuplicates: 0, deferred: 0 });
    expect((await wallets.get(walletA.id))?.balance.amount).toBe('90.00');
    expect((await wallets.get(walletB.id))?.balance.amount).toBe('90.00');
    expect((await wallets.reconcile(walletA.id))?.consistent).toBe(true);
    expect((await wallets.reconcile(walletB.id))?.consistent).toBe(true);
  });

  test('allows two independent consumer instances to process separate FIFO groups', async () => {
    const playerA = id();
    const playerB = id();
    const walletA = await wallets.open({ playerId: playerA, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const walletB = await wallets.open({ playerId: playerB, initialBalance: { amount: '100.00', currency: 'BRL' } });
    await send(envelope(request(walletA.id, playerA)), walletA.id);
    await send(envelope(request(walletB.id, playerB)), walletB.id);
    const workers = [consumer(), consumer()];
    const results = await Promise.all(workers.map((worker) => worker.runOnce()));
    expect(results.reduce((sum, result) => sum + result.acknowledged, 0)).toBe(2);
    expect(results.reduce((sum, result) => sum + result.received, 0)).toBe(2);
    expect((await wallets.get(walletA.id))?.balance.amount).toBe('90.00');
    expect((await wallets.get(walletB.id))?.balance.amount).toBe('90.00');
    expect((await wallets.reconcile(walletA.id))?.consistent).toBe(true);
    expect((await wallets.reconcile(walletB.id))?.consistent).toBe(true);
  });

  test('drains an in-flight real SQS delivery when the consumer is stopped', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = request(wallet.id, playerId);
    const message = envelope(input);
    await send(message, wallet.id);
    process.env.WAGER_TEST_ENABLE_FAULTS = 'true';
    process.env.WAGER_TEST_PAUSE_AFTER_COMMIT_MS = '1200';
    const worker = consumer(1, 1);
    try {
      worker.start();
      let committedInbox = false;
      for (let attempt = 0; attempt < 40 && !committedInbox; attempt += 1) {
        const [row] = await orm.em.getConnection().execute<Array<{ processed: boolean }>>(
          `select processed_at is not null as processed from inbox_messages where consumer_name = ? and message_id = ?`,
          [consumerName, message.messageId]);
        committedInbox = row?.processed === true;
        if (!committedInbox) await Bun.sleep(50);
      }
      expect(committedInbox).toBe(true);
      await worker.stop();
    } finally {
      delete process.env.WAGER_TEST_PAUSE_AFTER_COMMIT_MS;
      delete process.env.WAGER_TEST_ENABLE_FAULTS;
      await worker.stop();
    }
    const empty = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1, VisibilityTimeout: 1 }));
    expect(empty.Messages ?? []).toEqual([]);
    expect((await wallets.get(wallet.id))?.balance.amount).toBe('90.00');
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('ACKs REFUND before its reference and resolves it later through the shared domain worker', async () => {
    const playerId = id();
    const providerId = `sqs-${playerId}`;
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const refund = request(wallet.id, playerId, { providerId, kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'sqs-bet-arrives-later' });
    const message = envelope(refund);
    await send(message, wallet.id);
    expect(await consumer().runOnce()).toEqual({ received: 1, acknowledged: 1, inboxDuplicates: 0, deferred: 0 });
    expect((await rowFor(refund.providerId, refund.externalTransactionId))?.status).toBe(WagerTransactionStatus.PendingReference);
    const bet = request(wallet.id, playerId, { providerId, externalTransactionId: 'sqs-bet-arrives-later',
      roundId: refund.roundId, money: refund.money });
    expect((await wagers.process(bet, `reference:${id()}`)).status).toBe(WagerTransactionStatus.Processed);
    await orm.em.getConnection().execute(`update wager_transactions set next_attempt_at = now() - interval '1 second' where provider_id = ? and external_transaction_id = ?`,
      [refund.providerId, refund.externalTransactionId]);
    expect((await new PendingReferenceWorker(wagers).runOnce()).processed).toBe(1);
    expect((await rowFor(refund.providerId, refund.externalTransactionId))?.status).toBe(WagerTransactionStatus.Processed);
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('releases a real SQS message after a PostgreSQL serialization failure and processes it after recovery', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = request(wallet.id, playerId, { providerId: `sqs-transient-${playerId}` });
    const message = envelope(input);
    await orm.em.getConnection().execute(`create function fail_sqs_consumer_transaction() returns trigger language plpgsql as $$
      begin
        if exists(select 1 from wager_transactions where id = new.transaction_id and provider_id = '${input.providerId}') then
          raise exception 'temporary serialization failure' using errcode = '40001';
        end if;
        return new;
      end; $$`);
    await orm.em.getConnection().execute(`create trigger fail_sqs_consumer_ledger before insert on wallet_ledger_entries
      for each row execute function fail_sqs_consumer_transaction()`);
    try {
      await send(message, wallet.id);
      expect(await consumer().runOnce()).toEqual({ received: 1, acknowledged: 0, inboxDuplicates: 0, deferred: 1 });
      const [rolledBack] = await orm.em.getConnection().execute<Array<{ inbox: string; wagers: string; ledger: string }>>(
        `select (select count(*) from inbox_messages where consumer_name = ? and message_id = ?)::text as inbox,
          (select count(*) from wager_transactions where provider_id = ? and external_transaction_id = ?)::text as wagers,
          (select count(*) from wallet_ledger_entries l join wager_transactions w on w.id = l.transaction_id
            where l.wallet_id = ? and w.kind <> 'OPENING')::text as ledger`,
        [consumerName, message.messageId, input.providerId, input.externalTransactionId, wallet.id]);
      expect(rolledBack).toEqual({ inbox: '0', wagers: '0', ledger: '0' });
    } finally {
      await orm.em.getConnection().execute('drop trigger if exists fail_sqs_consumer_ledger on wallet_ledger_entries');
      await orm.em.getConnection().execute('drop function if exists fail_sqs_consumer_transaction()');
    }
    await Bun.sleep(1_100);
    expect(await consumer().runOnce()).toEqual({ received: 1, acknowledged: 1, inboxDuplicates: 0, deferred: 0 });
    expect((await rowFor(input.providerId, input.externalTransactionId))?.status).toBe(WagerTransactionStatus.Processed);
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('recovers redelivery when DeleteMessage fails after the database commit', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = request(wallet.id, playerId);
    const message = envelope(input);
    await send(message, wallet.id);
    process.env.WAGER_TEST_ENABLE_FAULTS = 'true';
    process.env.WAGER_TEST_FAIL_DELETE_ONCE = 'true';
    try {
      expect(await consumer().runOnce()).toEqual({ received: 1, acknowledged: 0, inboxDuplicates: 0, deferred: 1 });
    } finally {
      delete process.env.WAGER_TEST_FAIL_DELETE_ONCE;
      delete process.env.WAGER_TEST_ENABLE_FAULTS;
    }
    await Bun.sleep(1_100);
    expect(await consumer().runOnce()).toEqual({ received: 1, acknowledged: 1, inboxDuplicates: 1, deferred: 0 });
    const [counts] = await orm.em.getConnection().execute<Array<{ inbox: string; wagers: string; ledger: string }>>(
      `select (select count(*) from inbox_messages where consumer_name = ? and message_id = ?)::text as inbox,
        (select count(*) from wager_transactions where provider_id = ? and external_transaction_id = ?)::text as wagers,
        (select count(*) from wallet_ledger_entries l join wager_transactions w on w.id = l.transaction_id
          where l.wallet_id = ? and w.kind <> 'OPENING')::text as ledger`,
      [consumerName, message.messageId, input.providerId, input.externalTransactionId, wallet.id]);
    expect(counts).toEqual({ inbox: '1', wagers: '1', ledger: '1' });
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('recovers a real process crash after SQL commit and before SQS ACK after restart', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = request(wallet.id, playerId, { providerId: `sqs-crash-${playerId}` });
    const message = envelope(input);
    await send(message, wallet.id);
    const commonEnv = {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL!,
      SQS_ENDPOINT: endpoint,
      SQS_COMMAND_QUEUE_URL: queueUrl,
      SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
      SQS_CONSUMER_NAME: consumerName,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    };
    function startProcess(pauseAfterCommitMs?: string) {
      return Bun.spawn(['bun', 'run', 'dist/src/messaging/wager-sqs-consumer.main.js'], {
        cwd: process.cwd(),
        env: { ...commonEnv, WAGER_TEST_ENABLE_FAULTS: pauseAfterCommitMs ? 'true' : 'false',
          ...(pauseAfterCommitMs ? { WAGER_TEST_PAUSE_AFTER_COMMIT_MS: pauseAfterCommitMs } : {}) },
        stdout: 'pipe', stderr: 'pipe',
      });
    }
    const firstProcess = startProcess('30000');
    let firstOutput = '';
    let secondOutput = '';
    const readOutput = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          append(decoder.decode(value, { stream: true }));
        }
      } finally { reader.releaseLock(); }
    };
    const firstReader = readOutput(firstProcess.stdout, (chunk) => { firstOutput += chunk; });
    const firstErrorReader = readOutput(firstProcess.stderr, (chunk) => { firstOutput += chunk; });
    let secondProcess: ReturnType<typeof startProcess> | undefined;
    let secondReaders: Promise<void>[] = [];
    try {
      let committed = false;
      for (let attempt = 0; attempt < 100 && !committed; attempt += 1) {
        const [row] = await orm.em.getConnection().execute<Array<{ processed: boolean }>>(
          `select processed_at is not null as processed from inbox_messages where consumer_name = ? and message_id = ?`,
          [consumerName, message.messageId]);
        committed = row?.processed === true;
        if (!committed) await Bun.sleep(50);
      }
      expect(committed).toBe(true);
      firstProcess.kill('SIGKILL');
      await firstProcess.exited;
      await Promise.all([firstReader, firstErrorReader]);
      expect(firstOutput).not.toContain('wager_sqs_shutdown_complete');
      await Bun.sleep(2_200);

      secondProcess = startProcess();
      secondReaders = [
        readOutput(secondProcess.stdout, (chunk) => { secondOutput += chunk; }),
        readOutput(secondProcess.stderr, (chunk) => { secondOutput += chunk; }),
      ];
      for (let attempt = 0; attempt < 100 && !secondOutput.includes('wager_sqs_inbox_duplicate'); attempt += 1) {
        await Bun.sleep(100);
      }
      expect(secondOutput).toContain('wager_sqs_inbox_duplicate');
    } finally {
      if (firstProcess.exitCode === null) firstProcess.kill('SIGKILL');
      if (secondProcess && secondProcess.exitCode === null) secondProcess.kill('SIGTERM');
      await Promise.all([firstProcess.exited, ...(secondProcess ? [secondProcess.exited] : [])]);
      await Promise.allSettled([firstReader, firstErrorReader, ...secondReaders]);
    }
    const [counts] = await orm.em.getConnection().execute<Array<{ inbox: string; wagers: string; ledger: string }>>(
      `select (select count(*) from inbox_messages where consumer_name = ? and message_id = ?)::text as inbox,
        (select count(*) from wager_transactions where provider_id = ? and external_transaction_id = ?)::text as wagers,
        (select count(*) from wallet_ledger_entries l join wager_transactions w on w.id = l.transaction_id
          where l.wallet_id = ? and w.kind <> 'OPENING')::text as ledger`,
      [consumerName, message.messageId, input.providerId, input.externalTransactionId, wallet.id]);
    expect(counts).toEqual({ inbox: '1', wagers: '1', ledger: '1' });
    expect((await wallets.get(wallet.id))?.balance.amount).toBe('90.00');
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  }, 30_000);

  test('routes a permanently malformed FIFO message to its configured DLQ after the receive limit', async () => {
    await send('{ malformed json', 'poison-message-group');
    const worker = consumer(1, 1);
    let deliveries = 0;
    let deadLetterReceived = false;
    for (let attempt = 0; attempt < 7 && !deadLetterReceived; attempt += 1) {
      const stats = await worker.runOnce();
      if (stats.received) deliveries += 1;
      const deadLetter = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1, VisibilityTimeout: 2 }));
      deadLetterReceived = (deadLetter.Messages?.length ?? 0) > 0;
      if (!deadLetterReceived) await Bun.sleep(1_100);
    }
    expect(deliveries).toBeGreaterThanOrEqual(3);
    expect(deadLetterReceived).toBe(true);
  }, 15_000);
});

describe('PostgreSQL and LocalStack transactional outbox publisher phase 6', () => {
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
  const sqs = new SQSClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  let queueUrl = '';

  function publisher(overrides: Partial<ConstructorParameters<typeof OutboxPublisher>[2]> = {}, client = sqs): OutboxPublisher {
    return new OutboxPublisher(orm, client, { queueUrl, publisherId: `publisher-${id()}`, batchSize: 10,
      leaseMs: 2_000, retryBaseMs: 50, retryMaximumMs: 200, ...overrides });
  }

  function event(aggregateId: string, eventType = 'WagerTransactionProcessed') {
    const eventId = id();
    return { eventId, eventType, aggregateId, correlationId: id(), occurredAt: new Date().toISOString(), version: 1,
      data: { transactionId: id(), walletId: aggregateId, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } } };
  }

  async function insertEvent(envelope: ReturnType<typeof event>): Promise<void> {
    await orm.em.getConnection().execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values (?, ?, ?, ?, ?, 0)`,
      [envelope.eventId, envelope.aggregateId, envelope.eventType, JSON.stringify(envelope), envelope.occurredAt]);
  }

  async function receive(maxMessages = 10) {
    return await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 1, VisibilityTimeout: 2 }));
  }

  beforeEach(async () => {
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    const suffix = randomUUID().replaceAll('-', '');
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `wager-events-test-${suffix}.fifo`, Attributes: {
      FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '2',
    } }))).QueueUrl!;
    await orm.em.getConnection().execute('delete from outbox_messages');
    await orm.em.getConnection().execute(`create table if not exists outbox_test_receipts (
      event_id uuid primary key, applied_at timestamptz not null default now())`);
    await orm.em.getConnection().execute(`create table if not exists outbox_test_effects (
      event_id uuid primary key references outbox_test_receipts(event_id), effect_count integer not null)`);
    await orm.em.getConnection().execute('truncate outbox_test_effects, outbox_test_receipts');
  });

  afterAll(async () => {
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    sqs.destroy();
  });

  test('publishes the financial event types in per-wallet order and only emits balance changes when balance moves', async () => {
    const playerId = id();
    const wallet = await wallets.open({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const providerId = `outbox-${playerId}`;
    const roundId = `round-${id()}`;
    const gameId = 'outbox-integration-game';
    const bet = { providerId, externalTransactionId: id(), playerId, walletId: wallet.id, roundId, gameId,
      kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const betResult = await wagers.process(bet, `key:${id()}`);
    await wagers.process({ ...bet, externalTransactionId: id(), kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: bet.externalTransactionId, money: { amount: '5.00', currency: 'BRL' } }, `key:${id()}`);
    const loss = { ...bet, externalTransactionId: id(), kind: WagerTransactionKind.Loss, money: { amount: '1.00', currency: 'BRL' } };
    const lossResult = await wagers.process(loss, `key:${id()}`);
    await wagers.process({ ...bet, externalTransactionId: id(), money: { amount: '500.00', currency: 'BRL' } }, `key:${id()}`);
    await wagers.process({ ...bet, externalTransactionId: id(), kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: `missing-${id()}` }, `key:${id()}`);

    const expected = ['WagerTransactionProcessed', 'WalletBalanceChanged', 'WagerTransactionProcessed', 'WalletBalanceChanged',
      'WagerTransactionProcessed', 'WalletBalanceChanged', 'WagerTransactionProcessed', 'WagerTransactionRejected',
      'WagerTransactionPendingReference'];
    const observed: Array<{ eventId: string; eventType: string; aggregateId: string; data: Record<string, unknown> }> = [];
    for (let attempt = 0; attempt < expected.length; attempt += 1) {
      expect((await publisher().runOnce()).published).toBe(1);
      const batch = await receive();
      const message = batch.Messages?.[0];
      expect(message).toBeDefined();
      observed.push(JSON.parse(message!.Body!) as typeof observed[number]);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message!.ReceiptHandle! }));
    }
    expect(observed.map((item) => item.eventType)).toEqual(expected);
    expect(observed.every((item) => item.aggregateId === wallet.id)).toBe(true);
    expect(observed[0]?.eventId).toBe((await orm.em.getConnection().execute<Array<{ id: string }>>(
      `select id::text as id from outbox_messages where aggregate_id = ? order by publication_order limit 1`, [wallet.id]))[0]?.id);
    expect(observed.filter((item) => item.eventType === 'WalletBalanceChanged')).toHaveLength(3);
    expect(observed.some((item) => item.eventType === 'WalletBalanceChanged'
      && item.data.transactionId === lossResult.transactionId)).toBe(false);
    const [state] = await orm.em.getConnection().execute<Array<{ pending: string; published: string; attempts: string }>>(
      `select count(*) filter (where published_at is null)::text as pending,
        count(*) filter (where published_at is not null)::text as published,
        sum(attempts)::text as attempts from outbox_messages where aggregate_id = ?`, [wallet.id]);
    expect(state).toEqual({ pending: '0', published: String(expected.length), attempts: '0' });
    expect((await wallets.get(wallet.id))?.balance.amount).toBe('95.00');
    expect(betResult.status).toBe(WagerTransactionStatus.Processed);
    expect((await wallets.reconcile(wallet.id))?.consistent).toBe(true);
  });

  test('does not publish an uncommitted outbox row and marks published only after SQS confirmation', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    const envelope = event(wallet.id);
    let release!: () => void;
    let inserted!: () => void;
    const insertedPromise = new Promise<void>((resolve) => { inserted = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const transaction = orm.em.transactional(async (em) => {
      await em.execute(`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
        values (?, ?, ?, ?, ?, 0)`, [envelope.eventId, envelope.aggregateId, envelope.eventType,
        JSON.stringify(envelope), envelope.occurredAt]);
      inserted();
      await hold;
    });
    await insertedPromise;
    expect(await publisher().runOnce()).toEqual({ claimed: 0, published: 0, deferred: 0, staleClaims: 0 });
    expect((await receive(1)).Messages ?? []).toEqual([]);
    release();
    await transaction;
    expect(await publisher().runOnce()).toEqual({ claimed: 1, published: 1, deferred: 0, staleClaims: 0 });
    expect((await receive(1)).Messages?.length).toBe(1);
    const [row] = await orm.em.getConnection().execute<Array<{ published: boolean }>>(
      `select published_at is not null as published from outbox_messages where id = ?`, [envelope.eventId]);
    expect(row?.published).toBe(true);
  });

  test('persists retry count and capped backoff after SQS send failure, then publishes after recovery', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    const envelope = event(wallet.id);
    await insertEvent(envelope);
    const unavailableSqs = new SQSClient({ endpoint: 'http://127.0.0.1:4567', region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
    try {
      expect(await publisher({}, unavailableSqs).runOnce()).toEqual({ claimed: 1, published: 0, deferred: 1, staleClaims: 0 });
    } finally {
      unavailableSqs.destroy();
    }
    const [failed] = await orm.em.getConnection().execute<Array<{ attempts: number; nextAttemptAt: Date | string; lastError: string }>>(
      `select attempts, next_attempt_at as "nextAttemptAt", last_error as "lastError" from outbox_messages where id = ?`, [envelope.eventId]);
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError.length).toBeGreaterThan(0);
    expect(failed?.nextAttemptAt).toBeDefined();
    expect(await publisher().runOnce()).toEqual({ claimed: 0, published: 0, deferred: 0, staleClaims: 0 });
    await Bun.sleep(60);
    expect(await publisher().runOnce()).toEqual({ claimed: 1, published: 1, deferred: 0, staleClaims: 0 });
    expect(JSON.parse((await receive(1)).Messages?.[0]?.Body ?? '{}').eventId).toBe(envelope.eventId);
    const [row] = await orm.em.getConnection().execute<Array<{ attempts: number; published: boolean; lastError: string | null }>>(
      `select attempts, published_at is not null as published, last_error as "lastError" from outbox_messages where id = ?`, [envelope.eventId]);
    expect(row).toEqual({ attempts: 1, published: true, lastError: null });
  });

  test('two publishers claim different aggregates and a stale claim cannot overwrite the current owner', async () => {
    const firstWallet = await wallets.open({ playerId: id(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    const secondWallet = await wallets.open({ playerId: id(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    const first = event(firstWallet.id);
    const second = event(secondWallet.id);
    await insertEvent(first);
    await insertEvent(second);
    const concurrent = await Promise.all([publisher({ batchSize: 1 }).runOnce(), publisher({ batchSize: 1 }).runOnce()]);
    expect(concurrent.reduce((sum, value) => sum + value.published, 0)).toBe(2);
    const sent = await receive(10);
    expect(sent.Messages?.length).toBe(2);
    for (const message of sent.Messages ?? []) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
    }

    await orm.em.getConnection().execute('delete from outbox_messages');
    const contested = event(firstWallet.id);
    await insertEvent(contested);
    const stalePublisher = publisher({ publisherId: 'stale-worker', leaseMs: 1_000 });
    process.env.WAGER_OUTBOX_TEST_ENABLE_FAULTS = 'true';
    process.env.WAGER_OUTBOX_TEST_PAUSE_AFTER_SEND_MS = '1500';
    const staleRun = stalePublisher.runOnce();
    try {
      let visible = false;
      for (let attempt = 0; attempt < 30 && !visible; attempt += 1) {
        const [attributes] = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'] })).then((result) => [result.Attributes]);
        visible = attributes?.ApproximateNumberOfMessages === '1';
        if (!visible) await Bun.sleep(50);
      }
      expect(visible).toBe(true);
      expect(await publisher({ publisherId: 'still-leased' }).runOnce())
        .toEqual({ claimed: 0, published: 0, deferred: 0, staleClaims: 0 });
      delete process.env.WAGER_OUTBOX_TEST_ENABLE_FAULTS;
      delete process.env.WAGER_OUTBOX_TEST_PAUSE_AFTER_SEND_MS;
      await Bun.sleep(1_050);
      expect(await publisher({ publisherId: 'new-owner', leaseMs: 1_000 }).runOnce())
        .toEqual({ claimed: 1, published: 1, deferred: 0, staleClaims: 0 });
      expect(await staleRun).toEqual({ claimed: 1, published: 0, deferred: 0, staleClaims: 1 });
    } finally {
      delete process.env.WAGER_OUTBOX_TEST_PAUSE_AFTER_SEND_MS;
      delete process.env.WAGER_OUTBOX_TEST_ENABLE_FAULTS;
    }
    const [row] = await orm.em.getConnection().execute<Array<{ published: boolean; claimedBy: string | null }>>(
      `select published_at is not null as published, claimed_by as "claimedBy" from outbox_messages where id = ?`, [contested.eventId]);
    expect(row).toEqual({ published: true, claimedBy: null });
  }, 10_000);

  test('a downstream consumer deduplicates a redelivered event by persistent eventId', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    const envelope = event(wallet.id);
    await insertEvent(envelope);
    expect((await publisher().runOnce()).published).toBe(1);
    const delivery = (await receive(1)).Messages?.[0]!;
    const parsed = JSON.parse(delivery.Body!) as typeof envelope;
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: delivery.ReceiptHandle! }));
    const applyOnce = async (eventId: string) => orm.em.transactional(async (em) => {
      const [receipt] = await em.execute<Array<{ eventId: string }>>(
        `insert into outbox_test_receipts(event_id) values (?) on conflict do nothing returning event_id as "eventId"`, [eventId]);
      if (!receipt) return false;
      await em.execute(`insert into outbox_test_effects(event_id, effect_count) values (?, 1)`, [eventId]);
      return true;
    });
    expect(await applyOnce(parsed.eventId)).toBe(true);
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(parsed),
      MessageGroupId: parsed.aggregateId, MessageDeduplicationId: `${parsed.eventId}-redelivery` }));
    const redelivery = (await receive(1)).Messages?.[0]!;
    expect(await applyOnce((JSON.parse(redelivery.Body!) as typeof envelope).eventId)).toBe(false);
    const [counts] = await orm.em.getConnection().execute<Array<{ receipts: string; effects: string }>>(
      `select (select count(*) from outbox_test_receipts where event_id = ?)::text as receipts,
        (select count(*) from outbox_test_effects where event_id = ?)::text as effects`, [parsed.eventId, parsed.eventId]);
    expect(counts).toEqual({ receipts: '1', effects: '1' });
  });

  test('recovers separate publisher process crashes before send and after send before publishedAt', async () => {
    const wallet = await wallets.open({ playerId: id(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    const beforeSendEvent = event(wallet.id);
    let afterSendEvent = event(wallet.id);
    await insertEvent(beforeSendEvent);
    const baseEnv = {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL!,
      SQS_ENDPOINT: endpoint,
      SQS_EVENTS_QUEUE_URL: queueUrl,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      OUTBOX_PUBLISHER_ID: 'crash-recovery-test',
      OUTBOX_BATCH_SIZE: '1',
      OUTBOX_LEASE_MS: '1000',
      OUTBOX_POLL_INTERVAL_MS: '100',
    };
    const startProcess = (pause: 'claim' | 'send') => Bun.spawn(['bun', 'run', 'dist/src/messaging/outbox-publisher.main.js'], {
      cwd: process.cwd(),
      env: { ...baseEnv, WAGER_OUTBOX_TEST_ENABLE_FAULTS: 'true',
        ...(pause === 'claim' ? { WAGER_OUTBOX_TEST_PAUSE_AFTER_CLAIM_MS: '30000' }
          : { WAGER_OUTBOX_TEST_PAUSE_AFTER_SEND_MS: '30000' }) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 10_000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await predicate()) return true;
        await Bun.sleep(50);
      }
      return false;
    };
    const beforeCrash = startProcess('claim');
    try {
      expect(await waitFor(async () => {
        const [row] = await orm.em.getConnection().execute<Array<{ claimed: boolean }>>(
          `select claimed_by is not null as claimed from outbox_messages where id = ?`, [beforeSendEvent.eventId]);
        return row?.claimed === true;
      })).toBe(true);
      beforeCrash.kill('SIGKILL');
      await beforeCrash.exited;
      const [beforeState] = await orm.em.getConnection().execute<Array<{ published: boolean }>>(
        `select published_at is not null as published from outbox_messages where id = ?`, [beforeSendEvent.eventId]);
      expect(beforeState?.published).toBe(false);
      const [emptyQueue] = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'] })).then((result) => [result.Attributes]);
      expect(emptyQueue?.ApproximateNumberOfMessages).toBe('0');
      await Bun.sleep(1_100);
    } finally {
      if (beforeCrash.exitCode === null) beforeCrash.kill('SIGKILL');
    }

    const recoverBefore = Bun.spawn(['bun', 'run', 'dist/src/messaging/outbox-publisher.main.js'], {
      cwd: process.cwd(), env: { ...baseEnv, OUTBOX_PUBLISHER_ID: 'recover-before-send', WAGER_OUTBOX_TEST_ENABLE_FAULTS: 'false' },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      expect(await waitFor(async () => {
        const [row] = await orm.em.getConnection().execute<Array<{ published: boolean }>>(
          `select published_at is not null as published from outbox_messages where id = ?`, [beforeSendEvent.eventId]);
        return row?.published === true;
      })).toBe(true);
    } finally {
      if (recoverBefore.exitCode === null) recoverBefore.kill('SIGTERM');
      await recoverBefore.exited;
    }

    afterSendEvent = event(wallet.id);
    await insertEvent(afterSendEvent);
    const afterCrash = startProcess('send');
    try {
      expect(await waitFor(async () => {
        const [attributes] = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'] })).then((result) => [result.Attributes]);
        return attributes?.ApproximateNumberOfMessages === '2';
      })).toBe(true);
      const [pendingState] = await orm.em.getConnection().execute<Array<{ published: boolean }>>(
        `select published_at is not null as published from outbox_messages where id = ?`, [afterSendEvent.eventId]);
      expect(pendingState?.published).toBe(false);
      afterCrash.kill('SIGKILL');
      await afterCrash.exited;
      await Bun.sleep(1_100);
    } finally {
      if (afterCrash.exitCode === null) afterCrash.kill('SIGKILL');
    }

    const recoverAfter = Bun.spawn(['bun', 'run', 'dist/src/messaging/outbox-publisher.main.js'], {
      cwd: process.cwd(), env: { ...baseEnv, OUTBOX_PUBLISHER_ID: 'recover-after-send', WAGER_OUTBOX_TEST_ENABLE_FAULTS: 'false' },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      expect(await waitFor(async () => {
        const [row] = await orm.em.getConnection().execute<Array<{ published: boolean }>>(
          `select published_at is not null as published from outbox_messages where id = ?`, [afterSendEvent.eventId]);
        return row?.published === true;
      })).toBe(true);
    } finally {
      if (recoverAfter.exitCode === null) recoverAfter.kill('SIGTERM');
      await recoverAfter.exited;
    }

    const gracefulEvent = event(wallet.id);
    await insertEvent(gracefulEvent);
    const gracefulPublisher = Bun.spawn(['bun', 'run', 'dist/src/messaging/outbox-publisher.main.js'], {
      cwd: process.cwd(),
      env: { ...baseEnv, OUTBOX_PUBLISHER_ID: 'graceful-shutdown-test', OUTBOX_LEASE_MS: '5000',
        WAGER_OUTBOX_TEST_ENABLE_FAULTS: 'true', WAGER_OUTBOX_TEST_PAUSE_AFTER_SEND_MS: '1500' },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      expect(await waitFor(async () => {
        const [attributes] = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'] })).then((result) => [result.Attributes]);
        return attributes?.ApproximateNumberOfMessages === '3';
      })).toBe(true);
      gracefulPublisher.kill('SIGTERM');
      await gracefulPublisher.exited;
      const gracefulOutput = await new Response(gracefulPublisher.stdout).text()
        + await new Response(gracefulPublisher.stderr).text();
      expect(gracefulOutput).toContain('outbox_shutdown_complete');
      const [state] = await orm.em.getConnection().execute<Array<{ published: boolean }>>(
        `select published_at is not null as published from outbox_messages where id = ?`, [gracefulEvent.eventId]);
      expect(state?.published).toBe(true);
    } finally {
      if (gracefulPublisher.exitCode === null) gracefulPublisher.kill('SIGKILL');
      await gracefulPublisher.exited;
    }
    const messages = (await receive(10)).Messages ?? [];
    expect(messages.map((message) => (JSON.parse(message.Body!) as { eventId: string }).eventId)
      .filter((eventId) => [beforeSendEvent.eventId, afterSendEvent.eventId, gracefulEvent.eventId].includes(eventId)).sort())
      .toEqual([beforeSendEvent.eventId, afterSendEvent.eventId, gracefulEvent.eventId].sort());
  }, 30_000);
});
