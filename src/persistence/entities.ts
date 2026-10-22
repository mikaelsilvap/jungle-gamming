import { EntitySchema } from '@mikro-orm/core';

/** Persistence-only records. Domain objects remain free of ORM metadata. */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status!: string;
  failureCode?: string;
  resultBalanceAmount?: string;
  resultCurrency?: string;
  processedAt?: Date;
  createdAt!: Date;
  pendingAttempts!: number;
  nextAttemptAt?: Date;
}

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  publishedAt?: Date;
  attempts!: number;
  nextAttemptAt?: Date;
  claimedBy?: string;
  lockedUntil?: Date;
}

const uuid = { type: 'uuid' as const };
const text = { type: 'text' as const };
const timestamp = { type: 'timestamptz' as const };
const numeric = { type: 'numeric' as const, precision: 38, scale: 2 };

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { ...uuid, primary: true }, playerId: { ...uuid, fieldName: 'player_id' }, currency: { type: 'char', length: 3 },
    balanceAmount: { ...numeric, fieldName: 'balance_amount' }, version: { type: 'integer' },
    createdAt: { ...timestamp, fieldName: 'created_at' }, updatedAt: { ...timestamp, fieldName: 'updated_at' },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { ...uuid, primary: true }, providerId: { ...text, fieldName: 'provider_id' },
    externalTransactionId: { ...text, fieldName: 'external_transaction_id' },
    idempotencyKey: { ...text, fieldName: 'idempotency_key' }, payloadHash: { ...text, fieldName: 'payload_hash' },
    walletId: { ...uuid, fieldName: 'wallet_id' }, playerId: { ...uuid, fieldName: 'player_id' },
    roundId: { ...text, fieldName: 'round_id' }, gameId: { ...text, fieldName: 'game_id' }, kind: { ...text },
    amount: { ...numeric }, currency: { type: 'char', length: 3 },
    referenceExternalTransactionId: { ...text, fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { ...uuid, fieldName: 'reference_transaction_id', nullable: true },
    status: { ...text }, failureCode: { ...text, fieldName: 'failure_code', nullable: true },
    resultBalanceAmount: { ...numeric, fieldName: 'result_balance_amount', nullable: true },
    resultCurrency: { type: 'char', length: 3, fieldName: 'result_currency', nullable: true },
    processedAt: { ...timestamp, fieldName: 'processed_at', nullable: true }, createdAt: { ...timestamp, fieldName: 'created_at' },
    pendingAttempts: { type: 'integer', fieldName: 'pending_attempts' }, nextAttemptAt: { ...timestamp, fieldName: 'next_attempt_at', nullable: true },
  },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { ...uuid, primary: true }, walletId: { ...uuid, fieldName: 'wallet_id' }, transactionId: { ...uuid, fieldName: 'transaction_id' },
    direction: { ...text }, amount: { ...numeric }, currency: { type: 'char', length: 3 },
    balanceBefore: { ...numeric, fieldName: 'balance_before' }, balanceAfter: { ...numeric, fieldName: 'balance_after' },
    createdAt: { ...timestamp, fieldName: 'created_at' },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { ...text, primary: true, fieldName: 'consumer_name' }, messageId: { ...text, primary: true, fieldName: 'message_id' },
    payloadHash: { ...text, fieldName: 'payload_hash' }, receivedAt: { ...timestamp, fieldName: 'received_at' },
    processedAt: { ...timestamp, fieldName: 'processed_at', nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { ...uuid, primary: true }, aggregateId: { ...uuid, fieldName: 'aggregate_id' }, eventType: { ...text, fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' }, occurredAt: { ...timestamp, fieldName: 'occurred_at' },
    publishedAt: { ...timestamp, fieldName: 'published_at', nullable: true }, attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamp, fieldName: 'next_attempt_at', nullable: true }, claimedBy: { ...text, fieldName: 'claimed_by', nullable: true },
    lockedUntil: { ...timestamp, fieldName: 'locked_until', nullable: true },
  },
});

export const persistenceEntities = [WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema];
