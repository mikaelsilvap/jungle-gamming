import { DomainError, FailureCode, fail } from './errors/domain-error';
import { LedgerDirection } from './wagering/enums';
import { Money } from './money';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {}

export class WalletLedgerEntry {
  private readonly createdAtMs: number;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.createdAtMs = createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { id, walletId, transactionId, direction, money, balanceBefore, balanceAfter, createdAt } = props;
    if (!id || !walletId || !transactionId || !(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      fail(FailureCode.InvalidLedgerEntry, 'Ledger entry identifiers and timestamp are required.');
    }
    if (direction !== LedgerDirection.Debit && direction !== LedgerDirection.Credit) {
      fail(FailureCode.InvalidLedgerEntry, 'Ledger direction is invalid.');
    }
    if (!money.isPositive() || money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      fail(FailureCode.InvalidLedgerEntry, 'Ledger money must be positive and use one currency.');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      fail(FailureCode.InvalidLedgerEntry, 'Ledger balances cannot be negative.');
    }
    const entry = new WalletLedgerEntry(id, walletId, transactionId, direction, money, balanceBefore, balanceAfter, createdAt);
    if (!entry.isBalanced()) {
      throw new DomainError(FailureCode.InvalidLedgerEntry, 'Ledger movement does not reconcile with the before and after balances.');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  isBalanced(): boolean {
    if (this.money.currency !== this.balanceBefore.currency || this.money.currency !== this.balanceAfter.currency) {
      return false;
    }
    const expected = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
