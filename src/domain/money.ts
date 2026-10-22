import { DomainError, FailureCode, fail } from './errors/domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const MONEY_PATTERN = /^(\d+)\.(\d{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const supportedCurrencyValues = (Intl as typeof Intl & { supportedValuesOf(key: 'currency'): string[] }).supportedValuesOf;
const ISO_4217_CURRENCIES = new Set(supportedCurrencyValues('currency'));

/** Exact immutable money value. Amounts cross boundaries as fixed-scale decimal strings. */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string') {
      fail(FailureCode.InvalidMoney, 'Money amount must be a decimal string.');
    }
    const match = MONEY_PATTERN.exec(props.amount);
    if (!match) {
      fail(FailureCode.InvalidMoney, 'Money amount must use a non-negative decimal string with exactly two fractional digits.');
    }
    const currency = Money.validateCurrency(props.currency);
    const whole = BigInt(match[1]!);
    const cents = BigInt(match[2]!);
    return new Money(whole * 100n + cents, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.validateCurrency(currency));
  }

  private static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    return new Money(minorUnits, Money.validateCurrency(currency));
  }

  private static validateCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency) || !ISO_4217_CURRENCIES.has(currency)) {
      fail(FailureCode.InvalidCurrency, 'Currency must be a three-letter uppercase ISO-4217 code.');
    }
    return currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.fromMinorUnits(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return other instanceof Money && this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const whole = absolute / 100n;
    const cents = (absolute % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!(other instanceof Money)) {
      throw new DomainError(FailureCode.InvalidMoney, 'Money operation requires another Money value.');
    }
    if (this.currency !== other.currency) {
      fail(FailureCode.CurrencyMismatch, `Cannot combine ${this.currency} with ${other.currency}.`);
    }
  }
}
