import { describe, expect, it } from 'bun:test';
import {
  DomainError,
  FailureCode,
  InboxMessage,
  IntegrationEvent,
  LedgerDirection,
  Money,
  OutboxMessage,
  Wallet,
  WalletBalanceChanged,
  WalletLedgerEntry,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus,
} from '../../src/domain';

const now = new Date('2026-10-22T12:00:00.000Z');
const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

function expectCode(action: () => unknown, code: FailureCode): void {
  try {
    action();
    throw new Error(`Expected domain error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

function wager(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: money('25.00'),
    createdAt: now,
    ...overrides,
  });
}

function processedWager(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
  const transaction = wager(overrides);
  transaction.markProcessed(undefined, now);
  return transaction;
}

function reversal(
  kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  reference: WagerTransaction,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction {
  return wager({
    id: `${kind.toLowerCase()}-1`,
    externalTransactionId: `${kind.toLowerCase()}-external`,
    idempotencyKey: `provider-a:${kind.toLowerCase()}-external`,
    kind,
    referenceExternalTransactionId: reference.externalTransactionId,
    money: reference.money,
    ...overrides,
  });
}

describe('Money', () => {
  it('uses exact integer minor units and serializes a fixed scale', () => {
    const value = money('9007199254740993.09');
    expect(value.add(money('0.01')).toJSON()).toEqual({ amount: '9007199254740993.10', currency: 'BRL' });
    expect(money('0.10').subtract(money('0.03')).toString()).toBe('0.07');
    expect(Object.isFrozen(value)).toBe(true);
  });

  it.each(['', '1', '1.2', '1.234', '1e2', 'NaN', 'Infinity', '-1.00', '+1.00'])
    ('rejects invalid contract amount %s', (amount) => {
      expectCode(() => money(amount), FailureCode.InvalidMoney);
    });

  it.each(['brl', 'US', 'BRL1', 'ZZZ', ''])('rejects invalid currency %s', (currency) => {
    expectCode(() => money('1.00', currency), FailureCode.InvalidCurrency);
  });

  it('rejects arithmetic across currencies and preserves operands', () => {
    const brl = money('10.00');
    expectCode(() => brl.add(money('1.00', 'USD')), FailureCode.CurrencyMismatch);
    expect(brl.toString()).toBe('10.00');
    expect(brl.negate().toString()).toBe('-10.00');
    expect(brl.subtract(money('11.00')).isNegative()).toBe(true);
  });

  it('normalizes leading zeroes without losing exact decimal precision', () => {
    expect(money('0001.00').toString()).toBe('1.00');
  });
});

describe('Wallet and ledger', () => {
  it('debits and credits exactly, creating a matching immutable ledger entry and incrementing version', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00'), createdAt: now });
    expect(wallet.version).toBe(1);
    const debit = wallet.debit(money('25.25'), { id: 'entry-1', transactionId: 'tx-1' }, now);
    expect(wallet.balance.toString()).toBe('74.75');
    expect(wallet.version).toBe(2);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.isBalanced()).toBe(true);
    expect(Object.isFrozen(debit)).toBe(true);

    const credit = wallet.credit(money('0.25'), { id: 'entry-2', transactionId: 'tx-2' }, now);
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(3);
    expect(credit.direction).toBe(LedgerDirection.Credit);
    expect(credit.isBalanced()).toBe(true);
  });

  it('does not mutate the wallet after an insufficient debit', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00'), createdAt: now });
    expectCode(() => wallet.debit(money('10.01'), { id: 'entry-1', transactionId: 'tx-1' }, now), FailureCode.InsufficientFunds);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects negative opening balances, zero movements, and currency mismatches', () => {
    expectCode(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('1.00').negate() }), FailureCode.InvalidMoney);
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00'), createdAt: now });
    expectCode(() => wallet.credit(money('0.00'), { id: 'entry-1', transactionId: 'tx-1' }), FailureCode.AmountMustBePositive);
    expectCode(() => wallet.credit(money('1.00', 'USD'), { id: 'entry-1', transactionId: 'tx-1' }), FailureCode.CurrencyMismatch);
  });

  it('creates one OPENING ledger entry for a positive opening balance and none for a zero balance', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('12.50'), createdAt: now });
    const opening = WagerTransaction.createOpening({
      id: 'opening-1', providerId: 'internal', externalTransactionId: 'opening-1', idempotencyKey: 'opening-1',
      payloadHash: 'opening-hash', walletId: wallet.id, playerId: wallet.playerId, roundId: 'opening', gameId: 'internal',
      money: wallet.balance, createdAt: now,
    });
    const entry = wallet.createOpeningLedgerEntry('entry-opening', opening.id, now);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.toString()).toBe('0.00');
    expect(entry?.balanceAfter.toString()).toBe('12.50');
    expect(wallet.createOpeningLedgerEntry('duplicate-entry', opening.id, now)).toBeUndefined();

    const emptyWallet = Wallet.open({ id: 'wallet-2', playerId: 'player-2', initialBalance: money('0.00'), createdAt: now });
    expect(emptyWallet.createOpeningLedgerEntry('entry-empty', 'opening-empty', now)).toBeUndefined();
  });

  it('validates ledger balance arithmetic and rejects negative resulting balances', () => {
    expectCode(() => WalletLedgerEntry.create({
      id: 'entry-1', walletId: 'wallet-1', transactionId: 'tx-1', direction: LedgerDirection.Debit,
      money: money('10.00'), balanceBefore: money('20.00'), balanceAfter: money('9.99'), createdAt: now,
    }), FailureCode.InvalidLedgerEntry);
    expectCode(() => WalletLedgerEntry.create({
      id: 'entry-1', walletId: 'wallet-1', transactionId: 'tx-1', direction: LedgerDirection.Debit,
      money: money('10.00'), balanceBefore: money('5.00'), balanceAfter: money('5.00').subtract(money('10.00')), createdAt: now,
    }), FailureCode.InvalidLedgerEntry);
  });
});

describe('WagerTransaction', () => {
  it('enforces reference requirements and prevents provider-created OPENING transactions', () => {
    expectCode(() => wager({ kind: WagerTransactionKind.Refund }), FailureCode.ReferenceRequired);
    expectCode(() => wager({ kind: WagerTransactionKind.Bet, referenceExternalTransactionId: 'ref-1' }), FailureCode.ReferenceMismatch);
    expectCode(() => wager({ kind: WagerTransactionKind.Opening }), FailureCode.OpeningTransactionIsInternal);
    const opening = WagerTransaction.createOpening({
      id: 'opening-1', providerId: 'internal', externalTransactionId: 'opening-1', idempotencyKey: 'opening-1',
      payloadHash: 'opening-hash', walletId: 'wallet-1', playerId: 'player-1', roundId: 'opening', gameId: 'internal',
      money: money('10.00'), createdAt: now,
    });
    expect(opening.kind).toBe(WagerTransactionKind.Opening);
  });

  it('requires a supplied WIN reference to resolve and compares payload hashes for idempotency', () => {
    const bet = processedWager();
    const win = wager({
      id: 'win-1', externalTransactionId: 'win-ext', idempotencyKey: 'win-key',
      kind: WagerTransactionKind.Win, referenceExternalTransactionId: bet.externalTransactionId,
    });
    expectCode(() => win.markProcessed(undefined, now), FailureCode.ReferenceRequired);
    win.markProcessed(bet, now);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wager().matchesPayload('hash-1')).toBe(true);
    expect(wager().matchesPayload('different-hash')).toBe(false);
  });

  it('moves from PENDING to PENDING_REFERENCE to PROCESSED and freezes terminal transitions', () => {
    const bet = processedWager();
    const refund = reversal(WagerTransactionKind.Refund, bet);
    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    refund.markProcessed(bet, now);
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(refund.isTerminal()).toBe(true);
    expectCode(() => refund.reject(FailureCode.InsufficientFunds), FailureCode.InvalidTransactionState);
  });

  it('tracks rejection and failure as distinct terminal outcomes', () => {
    const rejected = wager();
    rejected.reject(FailureCode.InsufficientFunds);
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    const failed = wager({ id: 'tx-2', externalTransactionId: 'external-2', idempotencyKey: 'key-2' });
    failed.fail(FailureCode.ReferenceNotFound);
    expect(failed.status).toBe(WagerTransactionStatus.Failed);
    expect(failed.isTerminal()).toBe(true);
  });

  it('applies BET, WIN, and LOSS with the specified ledger effects', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00'), createdAt: now });
    const bet = wager();
    const betEntry = wallet.applyWager(bet, { id: 'entry-1' }, undefined, now);
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(betEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('75.00');

    const win = wager({ id: 'win-1', externalTransactionId: 'win-ext', idempotencyKey: 'win-key', kind: WagerTransactionKind.Win, money: money('40.00') });
    const winEntry = wallet.applyWager(win, { id: 'entry-2' }, undefined, now);
    expect(winEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe('115.00');

    const referencedWin = wager({
      id: 'win-2', externalTransactionId: 'win-ext-2', idempotencyKey: 'win-key-2',
      kind: WagerTransactionKind.Win, money: money('1.00'), referenceExternalTransactionId: bet.externalTransactionId,
    });
    referencedWin.markProcessed(bet, now);
    expect(referencedWin.referenceTransactionId).toBe(bet.id);

    const loss = wager({ id: 'loss-1', externalTransactionId: 'loss-ext', idempotencyKey: 'loss-key', kind: WagerTransactionKind.Loss });
    const versionBeforeLoss = wallet.version;
    expect(wallet.applyWager(loss, { id: 'entry-3' }, undefined, now)).toBeUndefined();
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toString()).toBe('115.00');
    expect(wallet.version).toBe(versionBeforeLoss);
  });

  it('applies REFUND and ROLLBACK once and reverses the referenced ledger direction', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00'), createdAt: now });
    const bet = wager();
    const betEntry = wallet.applyWager(bet, { id: 'entry-1' }, undefined, now);
    expect(betEntry?.direction).toBe(LedgerDirection.Debit);
    const refund = reversal(WagerTransactionKind.Refund, bet);
    const refundEntry = wallet.applyWager(refund, { id: 'entry-2' }, bet, now);
    expect(refundEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(3);

    const win = processedWager({ id: 'win-1', externalTransactionId: 'win-ext', idempotencyKey: 'win-key', kind: WagerTransactionKind.Win, money: money('10.00') });
    const rollback = reversal(WagerTransactionKind.Rollback, win);
    const rollbackEntry = wallet.applyWager(rollback, { id: 'entry-3' }, win, now);
    expect(rollbackEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('90.00');

    const originalBet = processedWager({ id: 'original-bet', externalTransactionId: 'original-bet', idempotencyKey: 'original-bet-key' });
    const refundForRollback = reversal(WagerTransactionKind.Refund, originalBet);
    refundForRollback.markProcessed(originalBet, now);
    const rollbackRefund = reversal(WagerTransactionKind.Rollback, refundForRollback);
    const rollbackRefundEntry = wallet.applyWager(rollbackRefund, { id: 'entry-4' }, refundForRollback, now);
    expect(rollbackRefundEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('65.00');
  });

  it('distinguishes a reversal overdraw from an ordinary insufficient BET', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('20.00'), createdAt: now });
    const win = processedWager({ id: 'win-1', externalTransactionId: 'win-ext', idempotencyKey: 'win-key', kind: WagerTransactionKind.Win, money: money('30.00') });
    const rollback = reversal(WagerTransactionKind.Rollback, win);
    expectCode(() => wallet.applyWager(rollback, { id: 'entry-1' }, win, now), FailureCode.ReversalWouldOverdraw);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(rollback.status).toBe(WagerTransactionStatus.Pending);
  });

  it('rejects mismatched or disallowed references, unequal reversals, and duplicate reversal attempts', () => {
    const bet = processedWager();
    expectCode(() => reversal(WagerTransactionKind.Refund, bet, { money: money('24.99') }).validateReference(bet), FailureCode.ReversalAmountMismatch);
    expectCode(() => reversal(WagerTransactionKind.Rollback, bet, { walletId: 'wallet-2' }).validateReference(bet), FailureCode.ReferenceMismatch);
    const loss = processedWager({ kind: WagerTransactionKind.Loss });
    expectCode(() => reversal(WagerTransactionKind.Refund, loss).validateReference(loss), FailureCode.ReferenceKindNotAllowed);
    expectCode(() => reversal(WagerTransactionKind.Refund, bet).validateReference(bet, true), FailureCode.ReferenceAlreadyReversed);
  });
});

describe('Inbox, events, and outbox', () => {
  it('tracks inbox receipt and processes the message once', () => {
    const inbox = InboxMessage.receive({ messageId: 'message-1', consumerName: 'wager-consumer', payloadHash: 'payload-hash', receivedAt: now });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(now);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.toISOString()).toBe(now.toISOString());
    expectCode(() => inbox.markProcessed(now), FailureCode.InvalidInboxMessage);
  });

  it('serializes versioned immutable event envelopes with decimal-string money', () => {
    const transaction = processedWager();
    const event = WagerTransactionProcessed.from(transaction, { eventId: 'event-1', correlationId: 'corr-1', occurredAt: now });
    expect(event.toJSON()).toEqual({
      eventId: 'event-1', eventType: 'WagerTransactionProcessed', aggregateId: 'wallet-1', correlationId: 'corr-1',
      occurredAt: now.toISOString(), version: 1,
      data: {
        transactionId: 'tx-1', providerId: 'provider-a', externalTransactionId: 'external-1', walletId: 'wallet-1',
        playerId: 'player-1', roundId: 'round-1', kind: WagerTransactionKind.Bet, money: { amount: '25.00', currency: 'BRL' },
      },
    });
    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
  });

  it('creates the required rejected, pending-reference, and balance-changed event types', () => {
    const rejected = wager();
    rejected.reject(FailureCode.InsufficientFunds);
    expect(WagerTransactionRejected.from(rejected, { eventId: 'event-r', correlationId: 'corr', occurredAt: now }).eventType)
      .toBe('WagerTransactionRejected');

    const pending = reversal(WagerTransactionKind.Rollback, processedWager());
    pending.markPendingReference();
    expect(WagerTransactionPendingReference.from(pending, { eventId: 'event-p', correlationId: 'corr', occurredAt: now }).eventType)
      .toBe('WagerTransactionPendingReference');

    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00'), createdAt: now });
    const entry = wallet.debit(money('1.00'), { id: 'entry-1', transactionId: 'tx-1' }, now);
    expect(WalletBalanceChanged.from(wallet, entry, { eventId: 'event-b', correlationId: 'corr', occurredAt: now }).eventType)
      .toBe('WalletBalanceChanged');
  });

  it('queues event envelopes and retries with capped exponential backoff until published', () => {
    const event = WagerTransactionProcessed.from(processedWager(), { eventId: 'event-1', correlationId: 'corr-1', occurredAt: now });
    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.isDue(now)).toBe(true);
    outbox.scheduleRetry(now, { baseDelayMs: 1_000, maxDelayMs: 2_500 });
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(new Date(now.getTime() + 999))).toBe(false);
    expectCode(() => outbox.scheduleRetry(new Date(now.getTime() + 500)), FailureCode.InvalidOutboxMessage);
    outbox.scheduleRetry(new Date(now.getTime() + 1_000), { baseDelayMs: 1_000, maxDelayMs: 2_500 });
    expect(outbox.attempts).toBe(2);
    outbox.scheduleRetry(new Date(now.getTime() + 3_000), { baseDelayMs: 1_000, maxDelayMs: 2_500 });
    expect(outbox.attempts).toBe(3);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 5_500);
    outbox.markPublished(new Date(now.getTime() + 5_500));
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 10_000))).toBe(false);
    expectCode(() => outbox.scheduleRetry(now), FailureCode.InvalidOutboxMessage);
  });
});
