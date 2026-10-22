import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { OpenWalletInput, WalletOpeningService } from './wallet-opening.service';
import {
  AmountExceedsStorageLimitError,
  InvalidLedgerCursorError,
  LedgerPage,
  WalletAlreadyExistsError,
} from './application/wallet-persistence.port';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertWalletId(walletId: string): void {
  if (!UUID_PATTERN.test(walletId)) throw new BadRequestException('walletId must be a UUID.');
}

@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletOpeningService) {}

  @Post()
  async open(@Body() body: unknown) {
    if (!isObject(body) || typeof body.playerId !== 'string' || !isObject(body.initialBalance)
      || typeof body.initialBalance.amount !== 'string' || typeof body.initialBalance.currency !== 'string') {
      throw new BadRequestException('playerId and a decimal string initialBalance are required.');
    }
    if (!UUID_PATTERN.test(body.playerId)) {
      throw new BadRequestException('playerId must be a UUID.');
    }
    const input: OpenWalletInput = {
      playerId: body.playerId,
      initialBalance: { amount: body.initialBalance.amount, currency: body.initialBalance.currency },
    };
    try {
      return await this.wallets.open(input);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException({ code: error.code, message: error.message });
      }
      if (error instanceof AmountExceedsStorageLimitError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('INVALID_')) {
        const message = 'message' in error ? String(error.message) : 'Invalid wallet request.';
        throw new BadRequestException({ code: error.code, message });
      }
      throw error;
    }
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    assertWalletId(walletId);
    const wallet = await this.wallets.get(walletId);
    if (!wallet) throw new NotFoundException('Wallet was not found.');
    return wallet;
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') rawLimit?: string) {
    assertWalletId(walletId);
    const rawLimitNumber = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(rawLimitNumber) || rawLimitNumber < 1 || rawLimitNumber > 100) {
      throw new BadRequestException('limit must be an integer from 1 to 100.');
    }
    let result: LedgerPage | null;
    try {
      result = await this.wallets.ledger(walletId, cursor, rawLimitNumber);
    } catch (error) {
      if (error instanceof InvalidLedgerCursorError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
    if (!result) throw new NotFoundException('Wallet was not found.');
    return result;
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    assertWalletId(walletId);
    const result = await this.wallets.reconcile(walletId);
    if (!result) throw new NotFoundException('Wallet was not found.');
    return result;
  }
}
