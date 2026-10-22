import { fail, FailureCode } from './errors/domain-error';
import { Money } from './money';
import { CreateLedgerEntryProps, WalletLedgerEntry } from './wallet-ledger-entry';
import { WagerTransaction } from './wager-transaction';
import { LedgerDirection, WagerTransactionKind } from './wagering/enums';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private readonly createdAtMs: number;
  private updatedAtMs: number;
  private openingBalanceForEntry: Money | undefined;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
    openingBalanceForEntry?: Money,
  ) {
    this.createdAtMs = createdAt.getTime();
    this.updatedAtMs = updatedAt.getTime();
    this.openingBalanceForEntry = openingBalanceForEntry;
  }

  static open(props: OpenWalletProps): Wallet {
    const { id, playerId, initialBalance } = props;
    const createdAt = props.createdAt ?? new Date();
    if (!id || !playerId || !(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      fail(FailureCode.InvalidWallet, 'Wallet identifiers and a valid creation time are required.');
    }
    if (initialBalance.isNegative()) {
      fail(FailureCode.InvalidMoney, 'Wallet initial balance cannot be negative.');
    }
    return new Wallet(id, playerId, initialBalance.currency, initialBalance, 1, createdAt, createdAt,
      initialBalance.isPositive() ? initialBalance : undefined);
  }

  static rehydrate(state: WalletState): Wallet {
    if (!state.id || !state.playerId || state.version < 1 || state.balance.currency !== state.currency || state.balance.isNegative()) {
      fail(FailureCode.InvalidWallet, 'Persisted wallet state violates wallet invariants.');
    }
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtMs);
  }

  createOpeningLedgerEntry(id: string, transactionId: string, at = this.createdAt): WalletLedgerEntry | undefined {
    if (!this.openingBalanceForEntry) return undefined;
    const initialBalance = this.openingBalanceForEntry;
    const entry = WalletLedgerEntry.create({
      id,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: initialBalance,
      createdAt: at,
    });
    this.openingBalanceForEntry = undefined;
    return entry;
  }

  debit(money: Money, entry: Pick<CreateLedgerEntryProps, 'id' | 'transactionId'>, at = new Date()): WalletLedgerEntry {
    this.assertPositiveSameCurrency(money);
    if (this._balance.isLessThan(money)) {
      fail(FailureCode.InsufficientFunds, 'Wallet balance is insufficient for this debit.');
    }
    return this.applyMovement(money, LedgerDirection.Debit, entry, at);
  }

  credit(money: Money, entry: Pick<CreateLedgerEntryProps, 'id' | 'transactionId'>, at = new Date()): WalletLedgerEntry {
    this.assertPositiveSameCurrency(money);
    return this.applyMovement(money, LedgerDirection.Credit, entry, at);
  }

  applyWager(
    transaction: WagerTransaction,
    entry: Pick<CreateLedgerEntryProps, 'id'>,
    reference?: WagerTransaction,
    at = new Date(),
    alreadyReversedBySameKind = false,
  ): WalletLedgerEntry | undefined {
    if (transaction.walletId !== this.id || transaction.playerId !== this.playerId) {
      fail(FailureCode.ReferenceMismatch, 'Wager transaction belongs to a different wallet or player.');
    }
    this.assertPositiveSameCurrency(transaction.money);
    if (transaction.kind === WagerTransactionKind.Opening) {
      fail(FailureCode.OpeningTransactionIsInternal, 'OPENING transactions are applied only while creating a wallet.');
    }
    if (transaction.kind === WagerTransactionKind.Loss) {
      transaction.markProcessed(undefined, at);
      return undefined;
    }

    const direction = transaction.ledgerDirectionFor(reference);
    if (!direction) {
      fail(FailureCode.InvalidTransactionState, `Transaction kind ${transaction.kind} has no wallet movement.`);
    }
    if (transaction.requiresReference()) {
      if (!reference) fail(FailureCode.ReferenceRequired, `${transaction.kind} requires a resolved reference.`);
      transaction.validateReference(reference, alreadyReversedBySameKind);
    }

    const before = this._balance;
    const after = direction === LedgerDirection.Credit
      ? before.add(transaction.money)
      : before.subtract(transaction.money);
    if (after.isNegative()) {
      fail(transaction.kind === WagerTransactionKind.Rollback
        ? FailureCode.ReversalWouldOverdraw
        : FailureCode.InsufficientFunds,
      transaction.kind === WagerTransactionKind.Rollback
        ? 'Rollback would make the wallet balance negative.'
        : 'Wallet balance is insufficient for this debit.');
    }
    const ledgerEntry = WalletLedgerEntry.create({
      id: entry.id,
      walletId: this.id,
      transactionId: transaction.id,
      direction,
      money: transaction.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    transaction.markProcessed(reference, at, alreadyReversedBySameKind);
    this._balance = after;
    this._version += 1;
    this.updatedAtMs = at.getTime();
    return ledgerEntry;
  }

  private assertPositiveSameCurrency(money: Money): void {
    if (!money.isPositive()) {
      fail(FailureCode.AmountMustBePositive, 'Wallet movements must be greater than zero.');
    }
    if (money.currency !== this.currency) {
      fail(FailureCode.CurrencyMismatch, `Wallet currency is ${this.currency}, not ${money.currency}.`);
    }
  }

  private applyMovement(
    money: Money,
    direction: LedgerDirection,
    entry: Pick<CreateLedgerEntryProps, 'id' | 'transactionId'>,
    at: Date,
  ): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const ledgerEntry = WalletLedgerEntry.create({
      ...entry,
      walletId: this.id,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1;
    this.updatedAtMs = at.getTime();
    return ledgerEntry;
  }
}
