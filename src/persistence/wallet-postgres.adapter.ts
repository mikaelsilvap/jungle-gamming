import { MikroORM } from '@mikro-orm/postgresql';
import { LedgerDirection, Money, Wallet, WalletLedgerEntry, WagerTransaction } from '../domain';
import {
  LedgerPage,
  InvalidLedgerCursorError,
  WalletAlreadyExistsError,
  WalletPersistencePort,
  WalletReconciliation,
  WalletResponse,
} from '../wallets/application/wallet-persistence.port';

function isUniqueViolation(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === 'object'; depth += 1) {
    if ('code' in candidate && (candidate as { code?: unknown }).code === '23505') return true;
    candidate = 'cause' in candidate ? (candidate as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** PostgreSQL adapter for wallet persistence and read models. */
export class WalletPostgresAdapter implements WalletPersistencePort {
  constructor(private readonly orm: MikroORM) {}

  async createAtomically(wallet: Wallet, openingTransaction?: WagerTransaction, openingLedger?: WalletLedgerEntry): Promise<void> {
    if ((openingTransaction === undefined) !== (openingLedger === undefined)) {
      throw new Error('Opening transaction and ledger entry must be persisted together.');
    }
    try {
      await this.orm.em.transactional(async (em) => {
        await em.execute(
          `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
          [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toJSON().amount, wallet.version, wallet.createdAt, wallet.updatedAt],
        );

        if (openingTransaction && openingLedger) {
          await em.execute(
            `insert into wager_transactions (
              id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
              round_id, game_id, kind, amount, currency, status, result_balance_amount, result_currency,
              processed_at, created_at, pending_attempts
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [openingTransaction.id, openingTransaction.providerId, openingTransaction.externalTransactionId,
              openingTransaction.idempotencyKey, openingTransaction.payloadHash, openingTransaction.walletId,
              openingTransaction.playerId, openingTransaction.roundId, openingTransaction.gameId,
              openingTransaction.kind, openingTransaction.money.toJSON().amount, openingTransaction.money.currency,
              openingTransaction.status, openingTransaction.money.toJSON().amount, openingTransaction.money.currency,
              openingTransaction.processedAt, openingTransaction.createdAt],
          );
          await em.execute(
            `insert into wallet_ledger_entries (
              id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [openingLedger.id, openingLedger.walletId, openingLedger.transactionId, LedgerDirection.Credit,
              openingLedger.money.toJSON().amount, openingLedger.money.currency,
              openingLedger.balanceBefore.toJSON().amount, openingLedger.balanceAfter.toJSON().amount,
              openingLedger.createdAt],
          );
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new WalletAlreadyExistsError();
      throw error;
    }
  }

  async getWallet(walletId: string): Promise<WalletResponse | null> {
    const [row] = await this.orm.em.getConnection().execute<Array<{
      id: string; player_id: string; currency: string; balance_amount: string; version: number;
      created_at: Date | string; updated_at: Date | string;
    }>>(
      'select id, player_id, currency, balance_amount::text as balance_amount, version, created_at, updated_at from wallets where id = ?',
      [walletId],
    );
    if (!row) return null;
    const currency = row.currency.trim();
    const wallet = Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency,
      balance: Money.from({ amount: row.balance_amount, currency }),
      version: row.version,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  async listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage | null> {
    let before: { createdAt: Date; id: string } | undefined;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
        if (typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.id)
          || !Number.isFinite(Date.parse(decoded.createdAt))) {
          throw new Error('Invalid cursor');
        }
        before = { createdAt: new Date(decoded.createdAt), id: decoded.id };
      } catch {
        throw new InvalidLedgerCursorError();
      }
    }
    const walletRows = await this.orm.em.getConnection().execute<Array<{ id: string }>>(
      'select id from wallets where id = ?', [walletId]);
    if (!walletRows[0]) return null;
    const where = before ? 'and (created_at, id) < (?, ?)' : '';
    const params: unknown[] = before ? [walletId, before.createdAt, before.id, limit + 1] : [walletId, limit + 1];
    const rows = await this.orm.em.getConnection().execute<Array<{
      id: string; wallet_id: string; transaction_id: string; direction: string; amount: string; currency: string;
      balance_before: string; balance_after: string; created_at: Date | string;
    }>>(
      `select id, wallet_id, transaction_id, direction, amount::text as amount, currency,
        balance_before::text as balance_before, balance_after::text as balance_after, created_at
       from wallet_ledger_entries where wallet_id = ? ${where}
       order by created_at desc, id desc limit ?`, params,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: new Date(last.created_at).toISOString(), id: last.id })).toString('base64url')
      : null;
    return {
      entries: page.map((row) => ({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: Money.from({ amount: row.amount, currency: row.currency.trim() }).toJSON(),
        balanceBefore: Money.from({ amount: row.balance_before, currency: row.currency.trim() }).toJSON(),
        balanceAfter: Money.from({ amount: row.balance_after, currency: row.currency.trim() }).toJSON(),
        createdAt: new Date(row.created_at).toISOString(),
      })),
      nextCursor,
    };
  }

  async reconcile(walletId: string): Promise<WalletReconciliation | null> {
    return this.orm.em.transactional(async (em) => {
      const [wallet] = await em.execute<Array<{ id: string; currency: string; balance_amount: string }>>(
        'select id, currency, balance_amount::text as balance_amount from wallets where id = ?', [walletId]);
      if (!wallet) return null;
      const [totals] = await em.execute<Array<{ calculated_balance: string; checked_entries: string }>>(
        `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as calculated_balance,
          count(*)::text as checked_entries from wallet_ledger_entries where wallet_id = ?`, [walletId]);
      if (!totals) throw new Error('PostgreSQL did not return reconciliation totals.');
      const currency = wallet.currency.trim();
      const storedBalance = Money.from({ amount: wallet.balance_amount, currency });
      const calculatedBalance = Money.from({ amount: totals.calculated_balance, currency });
      const difference = storedBalance.subtract(calculatedBalance);
      return {
        walletId,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: Number.parseInt(totals.checked_entries, 10),
      };
    }, { isolationLevel: 'repeatable read' });
  }
}
