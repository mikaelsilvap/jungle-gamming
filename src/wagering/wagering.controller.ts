import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, NotFoundException, Param, Post, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { WagerTransactionKind } from '../domain';
import { ExternalTransactionConflictError, IdempotencyConflictError, ProcessWagerInput, ProcessWagerService, TransientWagerPersistenceError, WalletNotFoundError } from './process-wager.service';

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: `${name} is required.` });
  return value;
}
function present(result: Awaited<ReturnType<ProcessWagerService['process']>>) {
  if (result.status === 'REJECTED') throw new UnprocessableEntityException({ ...result, code: result.failureCode });
  if (result.status === 'PENDING_REFERENCE' || result.status === 'PENDING') throw new HttpException(result, HttpStatus.ACCEPTED);
  return result;
}

@Controller()
export class WageringController {
  constructor(private readonly wagers: ProcessWagerService) {}

  @Post('wagering/transactions')
  @HttpCode(200)
  async submit(@Body() raw: unknown, @Headers('idempotency-key') key?: string) {
    if (!object(raw)) throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: 'Request body must be an object.' });
    if (!key?.trim()) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required.' });
    const kind = requiredString(raw, 'kind');
    if (!Object.values(WagerTransactionKind).includes(kind as WagerTransactionKind) || kind === WagerTransactionKind.Opening) {
      throw new BadRequestException({ code: 'INVALID_TRANSACTION_KIND', message: 'kind must be BET, WIN, LOSS, REFUND, or ROLLBACK.' });
    }
    if (!object(raw.money) || typeof raw.money.amount !== 'string' || typeof raw.money.currency !== 'string') {
      throw new BadRequestException({ code: 'INVALID_MONEY', message: 'money requires decimal-string amount and currency.' });
    }
    const input: ProcessWagerInput = {
      providerId: requiredString(raw, 'providerId'), externalTransactionId: requiredString(raw, 'externalTransactionId'),
      playerId: requiredString(raw, 'playerId'), walletId: requiredString(raw, 'walletId'),
      roundId: requiredString(raw, 'roundId'), gameId: requiredString(raw, 'gameId'),
      kind: kind as WagerTransactionKind,
      money: { amount: raw.money.amount, currency: raw.money.currency },
      ...(raw.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: requiredString(raw, 'referenceExternalTransactionId') }),
    };
    try { return present(await this.wagers.process(input, key)); }
    catch (error) {
      if (error instanceof IdempotencyConflictError) throw new ConflictException({ code: error.code, message: error.message });
      if (error instanceof ExternalTransactionConflictError) throw new ConflictException({ code: error.code, message: error.message });
      if (error instanceof WalletNotFoundError) throw new NotFoundException({ code: error.code, message: 'Wallet was not found.' });
      if (error instanceof TransientWagerPersistenceError) throw new ServiceUnavailableException({ code: error.code, message: error.message });
      if (error && typeof error === 'object' && 'code' in error && ['INVALID_MONEY', 'INVALID_CURRENCY', 'AMOUNT_MUST_BE_POSITIVE', 'REFERENCE_REQUIRED', 'REFERENCE_MISMATCH'].includes(String(error.code))) {
        throw new BadRequestException({ code: error.code, message: 'Wager payload violates domain validation.' });
      }
      throw error;
    }
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') id: string) {
    const result = await this.wagers.getById(id);
    if (!result) throw new NotFoundException({ code: 'WAGER_NOT_FOUND' });
    return present(result);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    const result = await this.wagers.getByExternal(providerId, externalId);
    if (!result) throw new NotFoundException({ code: 'WAGER_NOT_FOUND' });
    return present(result);
  }
}
