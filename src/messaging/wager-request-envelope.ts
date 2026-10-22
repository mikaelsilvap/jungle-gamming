import { createHash } from 'node:crypto';
import { Money, WagerTransactionKind } from '../domain';
import { ProcessWagerInput } from '../wagering/process-wager.service';

export interface WagerTransactionRequestedEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: ProcessWagerInput & { idempotencyKey: string };
}

export interface ParsedWagerRequest {
  envelope: WagerTransactionRequestedEnvelope;
  input: ProcessWagerInput;
  idempotencyKey: string;
  payloadHash: string;
}

export class InvalidWagerMessageError extends Error {
  readonly code = 'INVALID_WAGER_MESSAGE';
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function requiredString(record: Record<string, unknown>, field: string, maximumLength = 255): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    throw new InvalidWagerMessageError(`${field} must be a non-empty string no longer than ${maximumLength} characters.`);
  }
  return value;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new InvalidWagerMessageError(`${field} contains unsupported field '${unknown}'.`);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const transactionKinds = new Set<string>(Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening));

/** Parses and validates the README's versioned command envelope before any database work. */
export function parseWagerRequestEnvelope(body: string | undefined): ParsedWagerRequest {
  if (!body || body.length > 256_000) throw new InvalidWagerMessageError('Message body is empty or exceeds 256 KB.');
  let raw: unknown;
  try { raw = JSON.parse(body); }
  catch (error) { throw new InvalidWagerMessageError('Message body is not valid JSON.', { cause: error }); }
  if (!object(raw)) throw new InvalidWagerMessageError('Message envelope must be a JSON object.');
  hasOnlyKeys(raw, ['messageId', 'type', 'occurredAt', 'data'], 'Message envelope');
  const messageId = requiredString(raw, 'messageId', 128);
  if (raw.type !== 'WagerTransactionRequested') throw new InvalidWagerMessageError('Unsupported message type.');
  const occurredAt = requiredString(raw, 'occurredAt', 64);
  if (!Number.isFinite(Date.parse(occurredAt)) || !/^\d{4}-\d\d-\d\dT/.test(occurredAt)) {
    throw new InvalidWagerMessageError('occurredAt must be an ISO-8601 timestamp.');
  }
  if (!object(raw.data)) throw new InvalidWagerMessageError('Message data must be an object.');
  hasOnlyKeys(raw.data, ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId'], 'Message data');
  const data = raw.data;
  const providerId = requiredString(data, 'providerId');
  const externalTransactionId = requiredString(data, 'externalTransactionId');
  const idempotencyKey = requiredString(data, 'idempotencyKey');
  const playerId = requiredString(data, 'playerId', 36);
  const walletId = requiredString(data, 'walletId', 36);
  if (!UUID_PATTERN.test(playerId) || !UUID_PATTERN.test(walletId)) throw new InvalidWagerMessageError('playerId and walletId must be UUIDs.');
  const roundId = requiredString(data, 'roundId');
  const gameId = requiredString(data, 'gameId');
  const kind = requiredString(data, 'kind', 16);
  if (!transactionKinds.has(kind)) throw new InvalidWagerMessageError('kind must be BET, WIN, LOSS, REFUND, or ROLLBACK.');
  if (!object(data.money)) throw new InvalidWagerMessageError('money must be an object.');
  hasOnlyKeys(data.money, ['amount', 'currency'], 'money');
  if (typeof data.money.amount !== 'string' || typeof data.money.currency !== 'string') {
    throw new InvalidWagerMessageError('money.amount and money.currency must be strings.');
  }
  try { Money.from({ amount: data.money.amount, currency: data.money.currency }); }
  catch (error) { throw new InvalidWagerMessageError('money is invalid.', { cause: error }); }
  let referenceExternalTransactionId: string | undefined;
  if (data.referenceExternalTransactionId !== undefined) {
    referenceExternalTransactionId = requiredString(data, 'referenceExternalTransactionId');
  }
  const input: ProcessWagerInput = {
    providerId, externalTransactionId, playerId, walletId, roundId, gameId,
    kind: kind as WagerTransactionKind,
    money: { amount: data.money.amount, currency: data.money.currency },
    ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
  };
  const envelope: WagerTransactionRequestedEnvelope = {
    messageId, type: 'WagerTransactionRequested', occurredAt,
    data: { ...input, idempotencyKey },
  };
  return {
    envelope, input, idempotencyKey,
    payloadHash: createHash('sha256').update(canonical(envelope)).digest('hex'),
  };
}
