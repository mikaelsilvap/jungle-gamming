import { createHash, randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  DomainError, FailureCode, LedgerDirection, Money, WagerTransaction,
  WagerTransactionKind, WagerTransactionPendingReference, WagerTransactionProcessed,
  WagerTransactionRejected, WagerTransactionStatus, Wallet, WalletBalanceChanged,
} from '../domain';
import { OutboxMessage } from '../domain/outbox-message';
import { rehydrateWallet, rehydrateWagerTransaction } from '../persistence/rehydration';
import { WagerTransactionRecord, WalletRecord } from '../persistence/entities';
import { ReferenceRetryPolicy } from './reference-retry-policy';

export interface ProcessWagerInput {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: WagerTransactionKind; money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}
export interface WagerResult {
  transactionId: string; status: WagerTransactionStatus; balance: { amount: string; currency: string };
  idempotentReplay: boolean; failureCode?: FailureCode;
}
export class IdempotencyConflictError extends Error { readonly code = 'IDEMPOTENCY_CONFLICT'; }
export class ExternalTransactionConflictError extends Error { readonly code = 'EXTERNAL_TRANSACTION_CONFLICT'; }
export class WagerNotFoundError extends Error { readonly code = 'WAGER_NOT_FOUND'; }
export class WalletNotFoundError extends Error { readonly code = 'WALLET_NOT_FOUND'; }
export class TransientWagerPersistenceError extends Error {
  readonly code = 'TRANSIENT_DATABASE_FAILURE';
  constructor(cause: unknown) { super('A transient database failure prevented wager processing.', { cause }); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function transient(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === 'object'; i += 1) {
    if ('code' in current && ['40P01', '40001'].includes(String((current as { code: unknown }).code))) return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === 'object'; i += 1) {
    if ('code' in current) return String((current as { code: unknown }).code);
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}
function hashPayload(input: ProcessWagerInput): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}
function resultFrom(row: WagerTransactionRecord, replay: boolean, originalSnapshot = false): WagerResult {
  const status = originalSnapshot ? row.responseSnapshotStatus ?? row.status : row.status;
  const balanceAmount = originalSnapshot ? row.responseSnapshotBalanceAmount ?? row.resultBalanceAmount : row.resultBalanceAmount;
  const currency = originalSnapshot ? row.responseSnapshotCurrency ?? row.resultCurrency : row.resultCurrency;
  const failureCode = originalSnapshot && row.responseSnapshotStatus
    ? row.responseSnapshotFailureCode : row.failureCode;
  if (!balanceAmount || !currency) throw new Error('Wager response snapshot is missing.');
  return {
    transactionId: row.id,
    status: status as WagerTransactionStatus,
    balance: Money.from({ amount: balanceAmount, currency: currency.trim() }).toJSON(),
    idempotentReplay: replay,
    ...(failureCode ? { failureCode: failureCode as FailureCode } : {}),
  };
}

/** Shared transactional application use case for HTTP and future queue consumers. */
export class ProcessWagerService {
  constructor(
    private readonly orm: MikroORM,
    readonly referenceRetryPolicy = new ReferenceRetryPolicy(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(input: ProcessWagerInput, idempotencyKey: string): Promise<WagerResult> {
    const payloadHash = hashPayload(input);
    if (input.money.amount.split('.')[0]!.replace(/^0+/, '').length > 36) {
      throw new DomainError(FailureCode.InvalidMoney, 'Amount exceeds PostgreSQL NUMERIC(38,2) capacity.');
    }
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.processOnce(input, idempotencyKey, payloadHash); }
      catch (error) {
        if (postgresCode(error) === '23505') {
          const [sameKey] = await this.orm.em.getConnection().execute<WagerTransactionRecord[]>(
            `select ${wagerColumns} from wager_transactions where provider_id = ? and idempotency_key = ?`, [input.providerId, idempotencyKey]);
          if (sameKey) {
            if (sameKey.payloadHash.trim() !== payloadHash) throw new IdempotencyConflictError('Idempotency key was already used with a different payload.');
            return resultFrom(sameKey, true, true);
          }
          const [sameExternal] = await this.orm.em.getConnection().execute<Array<{ id: string }>>(
            'select id from wager_transactions where provider_id = ? and external_transaction_id = ?', [input.providerId, input.externalTransactionId]);
          if (sameExternal) throw new ExternalTransactionConflictError('External transaction identifier is already in use.');
        }
        if (!transient(error)) throw error;
        if (attempt >= 2) throw new TransientWagerPersistenceError(error);
      }
    }
  }

  private async processOnce(input: ProcessWagerInput, idempotencyKey: string, payloadHash: string): Promise<WagerResult> {
    const now = this.clock();
    return this.orm.em.transactional(async (em) => {
      const [walletRow] = await em.execute<WalletRecord[]>(
        `select id, player_id as "playerId", currency, balance_amount::text as "balanceAmount", version,
          created_at as "createdAt", updated_at as "updatedAt" from wallets where id = ? for update`, [input.walletId]);
      if (!walletRow) throw new WalletNotFoundError();
      if (walletRow.playerId !== input.playerId) throw new DomainError(FailureCode.ReferenceMismatch, 'Player does not own the requested wallet.');

      const [existing] = await em.execute<WagerTransactionRecord[]>(
        `select ${wagerColumns} from wager_transactions where provider_id = ? and idempotency_key = ?`, [input.providerId, idempotencyKey]);
      if (existing) {
        if (existing.payloadHash.trim() !== payloadHash) throw new IdempotencyConflictError('Idempotency key was already used with a different payload.');
        return resultFrom(existing, true, true);
      }

      const parsedMoney = Money.from(input.money);
      const id = randomUUID();
      const transaction = WagerTransaction.create({
        id, providerId: input.providerId, externalTransactionId: input.externalTransactionId,
        idempotencyKey, payloadHash, walletId: input.walletId, playerId: input.playerId,
        roundId: input.roundId, gameId: input.gameId, kind: input.kind, money: parsedMoney,
        ...(input.referenceExternalTransactionId ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}), createdAt: now,
      });
      const wallet = rehydrateWallet({
        ...walletRow,
        createdAt: walletRow.createdAt instanceof Date ? walletRow.createdAt : new Date(walletRow.createdAt),
        updatedAt: walletRow.updatedAt instanceof Date ? walletRow.updatedAt : new Date(walletRow.updatedAt),
      });
      await em.execute(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
          status, created_at, pending_attempts)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 0)`,
        [id, input.providerId, input.externalTransactionId, idempotencyKey, payloadHash, input.walletId, input.playerId,
          input.roundId, input.gameId, input.kind, parsedMoney.toJSON().amount, parsedMoney.currency,
          input.referenceExternalTransactionId ?? null, now]);

      let reference: WagerTransaction | undefined;
      let alreadyReversed = false;
      if (input.referenceExternalTransactionId) {
        const [referenceRow] = await em.execute<WagerTransactionRecord[]>(
          `select ${wagerColumns} from wager_transactions where provider_id = ? and external_transaction_id = ? for update`,
          [input.providerId, input.referenceExternalTransactionId]);
        if (referenceRow) {
          reference = rehydrateWagerTransaction({
            ...referenceRow,
            createdAt: referenceRow.createdAt instanceof Date ? referenceRow.createdAt : new Date(referenceRow.createdAt),
            ...(referenceRow.processedAt === undefined ? {} : {
              processedAt: referenceRow.processedAt instanceof Date ? referenceRow.processedAt : new Date(referenceRow.processedAt),
            }),
          });
          const [reversal] = await em.execute<Array<{ present: boolean }>>(
            `select exists(select 1 from wager_transactions where reference_transaction_id = ? and kind = ? and status = 'PROCESSED') as present`,
            [referenceRow.id, input.kind]);
          alreadyReversed = reversal?.present ?? false;
        }
      }
      try {
        if (transaction.requiresReference() && (!reference
          || (reference.status !== WagerTransactionStatus.Processed && !reference.isTerminal()))) {
          transaction.markPendingReference();
        } else {
          const ledger = wallet.applyWager(transaction, { id: randomUUID() }, reference, now, alreadyReversed);
          if (ledger) {
            await em.execute(`update wallets set balance_amount = ?, version = ?, updated_at = ? where id = ?`,
              [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt, wallet.id]);
            await em.execute(
              `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [ledger.id, ledger.walletId, ledger.transactionId, ledger.direction, ledger.money.toJSON().amount,
                ledger.money.currency, ledger.balanceBefore.toJSON().amount, ledger.balanceAfter.toJSON().amount, ledger.createdAt]);
          }
          const response = { amount: wallet.balance.toJSON().amount, currency: wallet.currency };
          await em.execute(`update wager_transactions set status = ?, reference_transaction_id = ?, processed_at = ?,
            result_balance_amount = ?, result_currency = ?, response_snapshot_status = ?, response_snapshot_failure_code = ?,
            response_snapshot_balance_amount = ?, response_snapshot_currency = ? where id = ?`,
          [transaction.status, transaction.referenceTransactionId ?? null, transaction.processedAt ?? null,
            response.amount, response.currency, transaction.status, transaction.failureCode ?? null, response.amount, response.currency, id]);
          if (transaction.status === WagerTransactionStatus.Processed) {
            await this.enqueue(em, WagerTransactionProcessed.from(transaction, { eventId: randomUUID(), correlationId: id, causationId: id, occurredAt: now }));
          }
          if (ledger) await this.enqueue(em, WalletBalanceChanged.from(wallet, ledger, { eventId: randomUUID(), correlationId: id, causationId: id, occurredAt: now }));
          if (transaction.status === WagerTransactionStatus.PendingReference) {
            await this.enqueue(em, WagerTransactionPendingReference.from(transaction, { eventId: randomUUID(), correlationId: id, causationId: id, occurredAt: now }));
          }
          return { transactionId: id, status: transaction.status, balance: response, idempotentReplay: false };
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        transaction.reject(error.code);
      }

      const response = { amount: wallet.balance.toJSON().amount, currency: wallet.currency };
      const pending = transaction.status === WagerTransactionStatus.PendingReference;
      const expiresAt = pending ? this.referenceRetryPolicy.expiresAt(now) : null;
      const nextAttemptAt = pending ? this.referenceRetryPolicy.initialAttemptAt(now) : null;
      await em.execute(`update wager_transactions set status = ?, failure_code = ?, result_balance_amount = ?, result_currency = ?,
        response_snapshot_status = ?, response_snapshot_failure_code = ?, response_snapshot_balance_amount = ?, response_snapshot_currency = ?,
        next_attempt_at = ?, reference_expires_at = ?, claimed_by = null, locked_until = null where id = ?`,
        [transaction.status, transaction.failureCode ?? null, response.amount, response.currency,
          transaction.status, transaction.failureCode ?? null, response.amount, response.currency, nextAttemptAt, expiresAt, id]);
      if (transaction.status === WagerTransactionStatus.Rejected) {
        await this.enqueue(em, WagerTransactionRejected.from(transaction, { eventId: randomUUID(), correlationId: id, causationId: id, occurredAt: now }));
      }
      if (transaction.status === WagerTransactionStatus.PendingReference) {
        await this.enqueue(em, WagerTransactionPendingReference.from(transaction, { eventId: randomUUID(), correlationId: id, causationId: id, occurredAt: now }));
      }
      return { transactionId: id, status: transaction.status, balance: response, idempotentReplay: false,
        ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}) };
    });
  }

  /** Claims a small batch in a short transaction; leases expire after process crashes. */
  async claimPending(workerId: string, now: Date, leaseMs = 30_000, limit = 50): Promise<string[]> {
    return this.orm.em.transactional(async (em) => {
      const rows = await em.execute<Array<{ id: string }>>(
        `with candidates as (
          select id from wager_transactions
          where status = 'PENDING_REFERENCE'
            and (next_attempt_at <= ? or reference_expires_at <= ?)
            and (locked_until is null or locked_until <= ?)
          order by reference_expires_at, next_attempt_at, created_at, id
          for update skip locked limit ?
        )
        update wager_transactions as wager
          set claimed_by = ?, locked_until = ?
          from candidates where wager.id = candidates.id
        returning wager.id`,
        [now, now, now, limit, workerId, new Date(now.getTime() + leaseMs)],
      );
      return rows.map((row) => row.id);
    });
  }

  /** Resumes an existing pending row without entering the HTTP idempotency path. */
  async resumePending(transactionId: string, workerId: string, now: Date): Promise<'processed' | 'rejected' | 'rescheduled' | 'skipped'> {
    const [snapshot] = await this.orm.em.getConnection().execute<Array<{ walletId: string }>>(
      `select wallet_id as "walletId" from wager_transactions where id = ?`, [transactionId]);
    if (!snapshot) return 'skipped';
    return this.orm.em.transactional(async (em) => {
      const [walletRow] = await em.execute<WalletRecord[]>(
        `select id, player_id as "playerId", currency, balance_amount::text as "balanceAmount", version,
          created_at as "createdAt", updated_at as "updatedAt" from wallets where id = ? for update`, [snapshot.walletId]);
      if (!walletRow) return 'skipped';
      const [pendingRow] = await em.execute<WagerTransactionRecord[]>(
        `select ${wagerColumns} from wager_transactions where id = ? for update`, [transactionId]);
      if (!pendingRow || pendingRow.status !== WagerTransactionStatus.PendingReference
        || pendingRow.claimedBy !== workerId || !pendingRow.lockedUntil
        || new Date(pendingRow.lockedUntil).getTime() <= now.getTime()) return 'skipped';

      const wallet = rehydrateWallet({
        ...walletRow,
        createdAt: walletRow.createdAt instanceof Date ? walletRow.createdAt : new Date(walletRow.createdAt),
        updatedAt: walletRow.updatedAt instanceof Date ? walletRow.updatedAt : new Date(walletRow.updatedAt),
      });
      const transaction = rehydrateWagerTransaction({
        ...pendingRow,
        createdAt: pendingRow.createdAt instanceof Date ? pendingRow.createdAt : new Date(pendingRow.createdAt),
      });
      const attempt = pendingRow.pendingAttempts + 1;
      const [referenceRow] = await em.execute<WagerTransactionRecord[]>(
        `select ${wagerColumns} from wager_transactions where provider_id = ? and external_transaction_id = ? for update`,
        [pendingRow.providerId, pendingRow.referenceExternalTransactionId]);
      const reference = referenceRow ? rehydrateWagerTransaction({
        ...referenceRow,
        createdAt: referenceRow.createdAt instanceof Date ? referenceRow.createdAt : new Date(referenceRow.createdAt),
        ...(referenceRow.processedAt === undefined ? {} : {
          processedAt: referenceRow.processedAt instanceof Date ? referenceRow.processedAt : new Date(referenceRow.processedAt),
        }),
      }) : undefined;
      const expiresAt = pendingRow.referenceExpiresAt instanceof Date
        ? pendingRow.referenceExpiresAt : new Date(pendingRow.referenceExpiresAt!);
      const ttlExpired = this.referenceRetryPolicy.isExpired(now, expiresAt);
      const attemptsExhausted = this.referenceRetryPolicy.hasExhaustedAttempts(attempt);

      let candidateFailure: FailureCode | undefined;
      if (reference && transaction.requiresReference()) {
        try { transaction.validateReferenceCandidate(reference); }
        catch (error) {
          if (!(error instanceof DomainError)) throw error;
          candidateFailure = error.code;
        }
      }
      const permanentReferenceFailure = reference?.status === WagerTransactionStatus.Rejected
        || reference?.status === WagerTransactionStatus.Failed;
      if (ttlExpired || attemptsExhausted || candidateFailure || permanentReferenceFailure) {
          const code = candidateFailure
            ?? (ttlExpired ? FailureCode.ReferenceExpired : undefined)
            ?? (attemptsExhausted ? FailureCode.ReferenceRetryExhausted : undefined)
            ?? (reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound);
          transaction.reject(code);
          await em.execute(`update wager_transactions set status = ?, failure_code = ?, pending_attempts = ?,
            next_attempt_at = null, claimed_by = null, locked_until = null,
            result_balance_amount = ?, result_currency = ? where id = ?`,
          [transaction.status, code, attempt, wallet.balance.toJSON().amount, wallet.currency, transactionId]);
          await this.enqueue(em, WagerTransactionRejected.from(transaction, {
            eventId: randomUUID(), correlationId: transactionId, causationId: transactionId, occurredAt: now,
          }));
          return 'rejected';
      }
      if (!reference || reference.status !== WagerTransactionStatus.Processed) {
        const nextAttemptAt = this.referenceRetryPolicy.nextAttemptAt(now, attempt, expiresAt);
        await em.execute(`update wager_transactions set pending_attempts = ?, next_attempt_at = ?, claimed_by = null,
          locked_until = null where id = ?`, [attempt, nextAttemptAt, transactionId]);
        return 'rescheduled';
      }

      const [reversal] = await em.execute<Array<{ present: boolean }>>(
        `select exists(select 1 from wager_transactions where reference_transaction_id = ? and kind = ? and status = 'PROCESSED') as present`,
        [reference.id, transaction.kind]);
      let ledger;
      try {
        ledger = wallet.applyWager(transaction, { id: randomUUID() }, reference, now, reversal?.present ?? false);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        transaction.reject(error.code);
      }
      if (ledger) {
        await em.execute(`update wallets set balance_amount = ?, version = ?, updated_at = ? where id = ?`,
          [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt, wallet.id]);
        await em.execute(`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
          balance_before, balance_after, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ledger.id, ledger.walletId, ledger.transactionId, ledger.direction, ledger.money.toJSON().amount,
          ledger.money.currency, ledger.balanceBefore.toJSON().amount, ledger.balanceAfter.toJSON().amount, ledger.createdAt]);
      }
      await em.execute(`update wager_transactions set status = ?, reference_transaction_id = ?, failure_code = ?, processed_at = ?,
        pending_attempts = ?, next_attempt_at = null, claimed_by = null, locked_until = null,
        result_balance_amount = ?, result_currency = ? where id = ?`,
      [transaction.status, transaction.referenceTransactionId ?? null, transaction.failureCode ?? null, transaction.processedAt ?? now,
        attempt, wallet.balance.toJSON().amount, wallet.currency, transactionId]);
      if (transaction.status === WagerTransactionStatus.Processed) {
        await this.enqueue(em, WagerTransactionProcessed.from(transaction, {
          eventId: randomUUID(), correlationId: transactionId, causationId: transactionId, occurredAt: now,
        }));
      } else {
        await this.enqueue(em, WagerTransactionRejected.from(transaction, {
          eventId: randomUUID(), correlationId: transactionId, causationId: transactionId, occurredAt: now,
        }));
      }
      if (ledger) await this.enqueue(em, WalletBalanceChanged.from(wallet, ledger, {
        eventId: randomUUID(), correlationId: transactionId, causationId: transactionId, occurredAt: now,
      }));
      return transaction.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
    });
  }

  private async enqueue(em: { execute: (sql: string, params?: unknown[]) => Promise<unknown> }, event: { eventId: string; aggregateId: string; eventType: string; occurredAt: Date; toJSON: () => Record<string, unknown> }): Promise<void> {
    const outbox = OutboxMessage.enqueue(event as never);
    await em.execute(`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
      values (?, ?, ?, ?::jsonb, ?, 0)`,
      [outbox.id, outbox.aggregateId, outbox.eventType, JSON.stringify(outbox.payload), outbox.occurredAt]);
  }

  async getById(id: string): Promise<WagerResult | null> {
    const [row] = await this.orm.em.getConnection().execute<WagerTransactionRecord[]>(
      `select ${wagerColumns} from wager_transactions where id = ? and kind <> 'OPENING'`, [id]);
    return row ? resultFrom(row, false) : null;
  }

  async getByExternal(providerId: string, externalId: string): Promise<WagerResult | null> {
    const [row] = await this.orm.em.getConnection().execute<WagerTransactionRecord[]>(
      `select ${wagerColumns} from wager_transactions where provider_id = ? and external_transaction_id = ? and kind <> 'OPENING'`, [providerId, externalId]);
    return row ? resultFrom(row, false) : null;
  }
}

const wagerColumns = `id, provider_id as "providerId", external_transaction_id as "externalTransactionId",
  idempotency_key as "idempotencyKey", payload_hash as "payloadHash", wallet_id as "walletId",
  player_id as "playerId", round_id as "roundId", game_id as "gameId", kind,
  amount::text as amount, currency, reference_external_transaction_id as "referenceExternalTransactionId",
  reference_transaction_id as "referenceTransactionId", status, failure_code as "failureCode",
  result_balance_amount::text as "resultBalanceAmount", result_currency as "resultCurrency",
  response_snapshot_status as "responseSnapshotStatus",
  response_snapshot_failure_code as "responseSnapshotFailureCode",
  response_snapshot_balance_amount::text as "responseSnapshotBalanceAmount",
  response_snapshot_currency as "responseSnapshotCurrency",
  processed_at as "processedAt", created_at as "createdAt", pending_attempts as "pendingAttempts",
  next_attempt_at as "nextAttemptAt", reference_expires_at as "referenceExpiresAt",
  claimed_by as "claimedBy", locked_until as "lockedUntil"`;
