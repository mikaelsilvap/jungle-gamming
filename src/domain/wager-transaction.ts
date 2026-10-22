import { DomainError, FailureCode, fail } from './errors/domain-error';
import { Money } from './money';
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from './wagering/enums';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  reversedByKinds?: WagerTransactionKind[];
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private readonly createdAtMs: number;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private processedAtMs: number | undefined;
  private readonly reversalKinds = new Set<WagerTransactionKind>();

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string,
    failureCode?: FailureCode,
    processedAt?: Date,
    reversedByKinds: readonly WagerTransactionKind[] = [],
  ) {
    this.createdAtMs = createdAt.getTime();
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this.processedAtMs = processedAt?.getTime();
    for (const kind of reversedByKinds) this.reversalKinds.add(kind);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      fail(FailureCode.OpeningTransactionIsInternal, 'OPENING transactions can only be created by wallet provisioning.');
    }
    return WagerTransaction.createWithStatus(props, WagerTransactionStatus.Pending);
  }

  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    if (!props.money.isPositive()) {
      fail(FailureCode.AmountMustBePositive, 'An OPENING transaction is only created for a positive initial balance.');
    }
    return WagerTransaction.createWithStatus({
      ...props,
      kind: WagerTransactionKind.Opening,
    }, WagerTransactionStatus.Pending);
  }

  private static createWithStatus(props: CreateWagerTransactionProps, status: WagerTransactionStatus): WagerTransaction {
    const required = [props.id, props.providerId, props.externalTransactionId, props.idempotencyKey, props.payloadHash,
      props.walletId, props.playerId, props.roundId, props.gameId];
    if (required.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      fail(FailureCode.InvalidTransactionState, 'Wager transaction identifiers and payload hash are required.');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      fail(FailureCode.InvalidTransactionState, 'Wager transaction kind is invalid.');
    }
    if (!(props.money instanceof Money) || !props.money.isPositive()) {
      fail(FailureCode.AmountMustBePositive, 'Wager transaction amount must be greater than zero.');
    }
    const requiresReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    const allowsOptionalReference = props.kind === WagerTransactionKind.Win;
    const hasReference = Boolean(props.referenceExternalTransactionId?.trim());
    if ((requiresReference && !hasReference) || (!requiresReference && !allowsOptionalReference && hasReference)) {
      fail(requiresReference ? FailureCode.ReferenceRequired : FailureCode.ReferenceMismatch,
        requiresReference ? `${props.kind} requires a reference transaction identifier.`
          : `${props.kind} cannot include a reference transaction identifier.`);
    }
    const createdAt = props.createdAt ?? new Date();
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      fail(FailureCode.InvalidTransactionState, 'Wager transaction creation time must be valid.');
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      createdAt,
      status,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt ?? new Date(),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.reversedByKinds,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this.processedAtMs === undefined ? undefined : new Date(this.processedAtMs); }
  get createdAt(): Date { return new Date(this.createdAtMs); }

  markProcessed(reference: WagerTransaction | undefined, at: Date, alreadyReversedBySameKind = false): void {
    this.assertMutable();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      fail(FailureCode.InvalidTransactionState, 'Processed time must be valid.');
    }
    if (this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback) {
      if (!reference) fail(FailureCode.ReferenceRequired, `${this.kind} requires a resolved reference.`);
      this.validateReference(reference, alreadyReversedBySameKind);
      this._referenceTransactionId = reference.id;
    } else if (this.kind === WagerTransactionKind.Win && this.referenceExternalTransactionId && !reference) {
      fail(FailureCode.ReferenceRequired, 'WIN with a supplied reference must resolve it before processing.');
    } else if (reference) {
      this.assertReferenceIdentity(reference);
      if (reference.status !== WagerTransactionStatus.Processed) {
        fail(FailureCode.ReferenceNotProcessed, 'A supplied reference must already be PROCESSED.');
      }
      if (this.kind === WagerTransactionKind.Win && reference.kind !== WagerTransactionKind.Bet) {
        fail(FailureCode.ReferenceKindNotAllowed, 'WIN can only reference a BET.');
      }
      this._referenceTransactionId = reference.id;
    }
    if (reference && this.requiresReference()) reference.reversalKinds.add(this.kind);
    this._status = WagerTransactionStatus.Processed;
    this.processedAtMs = at.getTime();
  }

  markPendingReference(): void {
    this.assertMutable();
    if (this.kind !== WagerTransactionKind.Refund && this.kind !== WagerTransactionKind.Rollback) {
      fail(FailureCode.ReferenceRequired, 'Only operations requiring a reference can wait for one.');
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.markTerminal(WagerTransactionStatus.Rejected, code);
  }

  fail(code: FailureCode): void {
    this.markTerminal(WagerTransactionStatus.Failed, code);
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.Processed
      || this._status === WagerTransactionStatus.Rejected
      || this._status === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) fail(FailureCode.ReferenceRequired, 'ROLLBACK requires a resolved reference.');
        const referencedDirection = reference.ledgerDirectionFor();
        if (!referencedDirection) fail(FailureCode.ReferenceKindNotAllowed, 'ROLLBACK cannot reverse an operation without a ledger movement.');
        return referencedDirection === LedgerDirection.Credit ? LedgerDirection.Debit : LedgerDirection.Credit;
      }
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Opening:
        return undefined;
    }
  }

  validateReference(reference: WagerTransaction, alreadyReversedBySameKind = false): void {
    this.assertReferenceIdentity(reference);
    if (reference.status !== WagerTransactionStatus.Processed) {
      fail(FailureCode.ReferenceNotProcessed, 'A reversal can only reference a PROCESSED transaction.');
    }
    const kindAllowed = this.kind === WagerTransactionKind.Refund
      ? reference.kind === WagerTransactionKind.Bet
      : this.kind === WagerTransactionKind.Rollback
        ? reference.kind === WagerTransactionKind.Bet
          || reference.kind === WagerTransactionKind.Win
          || reference.kind === WagerTransactionKind.Refund
        : false;
    if (!kindAllowed) {
      fail(FailureCode.ReferenceKindNotAllowed, `${this.kind} cannot reverse ${reference.kind}.`);
    }
    if (alreadyReversedBySameKind) {
      fail(FailureCode.ReferenceAlreadyReversed, `This transaction has already been reversed by ${this.kind}.`);
    }
    if (reference.reversalKinds.has(this.kind)) {
      fail(FailureCode.ReferenceAlreadyReversed, `This transaction has already been reversed by ${this.kind}.`);
    }
    if (!this.money.equals(reference.money)) {
      fail(FailureCode.ReversalAmountMismatch, 'Reversal amount must equal the referenced transaction amount.');
    }
  }

  private assertReferenceIdentity(reference: WagerTransaction): void {
    if (!reference || reference.providerId !== this.providerId
      || reference.externalTransactionId !== this.referenceExternalTransactionId
      || reference.playerId !== this.playerId
      || reference.walletId !== this.walletId
      || reference.roundId !== this.roundId
      || reference.money.currency !== this.money.currency) {
      fail(FailureCode.ReferenceMismatch, 'Referenced transaction must match provider, external identifier, player, wallet, round, and currency.');
    }
  }

  private markTerminal(status: WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed, code: FailureCode): void {
    this.assertMutable();
    if (!Object.values(FailureCode).includes(code)) {
      fail(FailureCode.InvalidTransactionState, 'A stable failure code is required.');
    }
    this._status = status;
    this._failureCode = code;
  }

  private assertMutable(): void {
    if (this.isTerminal()) {
      throw new DomainError(FailureCode.InvalidTransactionState, `Cannot change terminal transaction ${this.id} (${this._status}).`);
    }
  }
}
