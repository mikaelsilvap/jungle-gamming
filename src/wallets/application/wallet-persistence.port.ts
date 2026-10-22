import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction } from '../../domain/wager-transaction';
import { OutboxMessage } from '../../domain/outbox-message';

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export interface LedgerPage {
  entries: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

export interface WalletReconciliation {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

/** Application port. The adapter must persist every supplied record atomically. */
export interface WalletPersistencePort {
  createAtomically(wallet: Wallet, openingTransaction?: WagerTransaction, openingLedger?: WalletLedgerEntry, outbox?: readonly OutboxMessage[]): Promise<void>;
  getWallet(walletId: string): Promise<WalletResponse | null>;
  listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage | null>;
  reconcile(walletId: string): Promise<WalletReconciliation | null>;
}

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor() {
    super('A wallet already exists for this player and currency.');
    this.name = 'WalletAlreadyExistsError';
  }
}

export class AmountExceedsStorageLimitError extends Error {
  readonly code = 'AMOUNT_EXCEEDS_STORAGE_LIMIT';
  constructor() {
    super('Amount exceeds PostgreSQL NUMERIC(38,2) capacity.');
    this.name = 'AmountExceedsStorageLimitError';
  }
}

export class InvalidLedgerCursorError extends Error {
  readonly code = 'INVALID_LEDGER_CURSOR';
  constructor() {
    super('Invalid ledger cursor.');
    this.name = 'InvalidLedgerCursorError';
  }
}
