import { createHash, randomUUID } from 'node:crypto';
import { Money, Wallet, WagerTransaction, WagerTransactionProcessed, WalletBalanceChanged, OutboxMessage } from '../domain';
import {
  AmountExceedsStorageLimitError,
  LedgerPage,
  WalletPersistencePort,
  WalletReconciliation,
  WalletResponse,
} from './application/wallet-persistence.port';
import { currentLogContext } from '../observability/logger';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

/** Application use case shared by HTTP and any future internal adapter. */
export class WalletOpeningService {
  constructor(private readonly persistence: WalletPersistencePort) {}

  async open(input: OpenWalletInput): Promise<WalletResponse> {
    const id = randomUUID();
    const now = new Date();
    const initialBalance = Money.from(input.initialBalance);
    if (initialBalance.toJSON().amount.split('.')[0]!.length > 36) {
      throw new AmountExceedsStorageLimitError();
    }
    const wallet = Wallet.open({ id, playerId: input.playerId, initialBalance, createdAt: now });

    if (initialBalance.isPositive()) {
      const transactionId = randomUUID();
      const payload = JSON.stringify({ playerId: input.playerId, walletId: id, initialBalance: initialBalance.toJSON() });
      const payloadHash = createHash('sha256').update(payload).digest('hex');
      const openingTransaction = WagerTransaction.createOpening({
        id: transactionId,
        providerId: '__internal__',
        externalTransactionId: `opening:${id}`,
        idempotencyKey: `opening:${id}`,
        payloadHash,
        walletId: id,
        playerId: input.playerId,
        roundId: `opening:${id}`,
        gameId: '__wallet__',
        money: initialBalance,
        createdAt: now,
      });
      openingTransaction.markProcessed(undefined, now);
      const openingLedger = wallet.createOpeningLedgerEntry(randomUUID(), transactionId, now);
      if (!openingLedger) throw new Error('Positive wallet opening did not produce a ledger entry.');
      const context = () => ({ eventId: randomUUID(), correlationId: currentLogContext().correlationId ?? transactionId,
        causationId: transactionId, occurredAt: now });
      const outbox = [
        OutboxMessage.enqueue(WagerTransactionProcessed.from(openingTransaction, context())),
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingLedger, context())),
      ];
      await this.persistence.createAtomically(wallet, openingTransaction, openingLedger, outbox);
    } else {
      await this.persistence.createAtomically(wallet);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  get(walletId: string): Promise<WalletResponse | null> {
    return this.persistence.getWallet(walletId);
  }

  ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage | null> {
    return this.persistence.listLedger(walletId, cursor, limit);
  }

  reconcile(walletId: string): Promise<WalletReconciliation | null> {
    return this.persistence.reconcile(walletId);
  }
}
