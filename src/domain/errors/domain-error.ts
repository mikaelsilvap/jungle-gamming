export enum FailureCode {
  InvalidMoney = 'INVALID_MONEY',
  InvalidCurrency = 'INVALID_CURRENCY',
  InvalidWallet = 'INVALID_WALLET',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  AmountMustBePositive = 'AMOUNT_MUST_BE_POSITIVE',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  OpeningTransactionIsInternal = 'OPENING_TRANSACTION_IS_INTERNAL',
  ReferenceRequired = 'REFERENCE_REQUIRED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  InvalidTransactionState = 'INVALID_TRANSACTION_STATE',
  InvalidLedgerEntry = 'INVALID_LEDGER_ENTRY',
  InvalidInboxMessage = 'INVALID_INBOX_MESSAGE',
  InvalidOutboxMessage = 'INVALID_OUTBOX_MESSAGE',
  InvalidEvent = 'INVALID_EVENT',
}

export class DomainError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function fail(code: FailureCode, message: string): never {
  throw new DomainError(code, message);
}
