import {
  InboxMessage,
  Money,
  OutboxMessage,
  Wallet,
  WalletLedgerEntry,
  WagerTransaction,
} from '../domain';
import { InboxMessageRecord, OutboxMessageRecord, WalletLedgerEntryRecord, WalletRecord, WagerTransactionRecord } from './entities';

export function rehydrateWallet(row: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency.trim(),
    balance: Money.from({ amount: row.balanceAmount, currency: row.currency.trim() }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function rehydrateWagerTransaction(row: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash.trim(),
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransaction['kind'],
    money: Money.from({ amount: row.amount, currency: row.currency.trim() }),
    ...(row.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: row.referenceExternalTransactionId }),
    createdAt: row.createdAt,
    status: row.status as WagerTransaction['status'],
    ...(row.referenceTransactionId === undefined ? {} : { referenceTransactionId: row.referenceTransactionId }),
    ...(row.failureCode === undefined ? {} : { failureCode: row.failureCode as NonNullable<WagerTransaction['failureCode']> }),
    ...(row.processedAt === undefined ? {} : { processedAt: row.processedAt }),
  });
}

export function rehydrateLedgerEntry(row: WalletLedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as WalletLedgerEntry['direction'],
    money: Money.from({ amount: row.amount, currency: row.currency.trim() }),
    balanceBefore: Money.from({ amount: row.balanceBefore, currency: row.currency.trim() }),
    balanceAfter: Money.from({ amount: row.balanceAfter, currency: row.currency.trim() }),
    createdAt: row.createdAt,
  });
}

export function rehydrateInboxMessage(row: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash.trim(),
    receivedAt: row.receivedAt,
    ...(row.processedAt === undefined ? {} : { processedAt: row.processedAt }),
  });
}

export function rehydrateOutboxMessage(row: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    ...(row.nextAttemptAt === undefined ? {} : { nextAttemptAt: row.nextAttemptAt }),
    ...(row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt }),
  });
}
