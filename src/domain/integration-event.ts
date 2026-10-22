import { fail, FailureCode } from './errors/domain-error';
import { MoneyProps } from './money';
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from './wagering/enums';
import { Wallet } from './wallet';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { WagerTransaction } from './wager-transaction';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

function freezeData<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeData(child);
  }
  return value;
}

function cloneAndFreezeData<T extends object>(value: T): Readonly<T> {
  let clone: T;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Event data is not JSON serializable.');
    clone = JSON.parse(serialized) as T;
  } catch {
    fail(FailureCode.InvalidEvent, 'Event data must be JSON serializable.');
  }
  return freezeData(clone);
}

export abstract class IntegrationEvent<T extends object> {
  private readonly occurredAtMs: number;
  readonly data: Readonly<T>;
  abstract readonly eventType: string;
  abstract readonly version: number;

  protected constructor(props: IntegrationEventProps<T>) {
    if (!props.eventId || !props.aggregateId || !props.correlationId
      || !(props.occurredAt instanceof Date) || Number.isNaN(props.occurredAt.getTime())) {
      fail(FailureCode.InvalidEvent, 'Event identifiers and occurrence time are required.');
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAtMs = props.occurredAt.getTime();
    this.data = cloneAndFreezeData(props.data);
  }

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;

  get occurredAt(): Date { return new Date(this.occurredAtMs); }

  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
  } {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.Processed) {
      fail(FailureCode.InvalidEvent, 'Processed event requires a PROCESSED transaction.');
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionProcessedData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    if (transaction.status !== WagerTransactionStatus.Rejected || !transaction.failureCode) {
      fail(FailureCode.InvalidEvent, 'Rejected event requires a REJECTED transaction with a failure code.');
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode,
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id || !entry.isBalanced()) {
      fail(FailureCode.InvalidEvent, 'Balance event requires a balanced ledger entry for the given wallet.');
    }
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionProcessedData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    if (transaction.status !== WagerTransactionStatus.PendingReference || !transaction.referenceExternalTransactionId) {
      fail(FailureCode.InvalidEvent, 'Pending-reference transaction must identify its external reference.');
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}
