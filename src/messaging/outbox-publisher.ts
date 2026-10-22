import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../domain/outbox-message';
import { logEvent, withLogContext } from '../observability/logger';
import { metrics } from '../observability/metrics';

interface OutboxRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date | string;
  attempts: number;
  nextAttemptAt?: Date | string | null;
  publicationOrder: string;
  claimToken: string;
}

export interface OutboxPublisherOptions {
  queueUrl: string;
  publisherId: string;
  batchSize?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  retryMaximumMs?: number;
  pollIntervalMs?: number;
}

export interface OutboxPublisherStats {
  claimed: number;
  published: number;
  deferred: number;
  staleClaims: number;
}

function date(value: Date | string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function errorText(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const code = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'unknown';
  return `${name}:${code}`.slice(0, 200);
}

/** PostgreSQL-backed at-least-once publisher for the transactional outbox. */
export class OutboxPublisher {
  private stopping = false;
  private runPromise: Promise<void> | undefined;

  constructor(private readonly orm: MikroORM, private readonly sqs: SQSClient, private readonly options: OutboxPublisherOptions) {
    if (!options.queueUrl || !options.publisherId) throw new Error('SQS queue URL and publisher identity are required.');
    const batchSize = options.batchSize ?? 10;
    const leaseMs = options.leaseMs ?? 30_000;
    const retryBaseMs = options.retryBaseMs ?? 1_000;
    const retryMaximumMs = options.retryMaximumMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000
      || !Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1
      || !Number.isSafeInteger(retryMaximumMs) || retryMaximumMs < retryBaseMs
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new Error('Outbox batch size, lease, retry policy, and polling interval must be valid.');
    }
  }

  start(): void {
    if (this.runPromise) return;
    this.stopping = false;
    this.runPromise = this.pollLoop().finally(() => { this.runPromise = undefined; });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.runPromise;
  }

  async runOnce(): Promise<OutboxPublisherStats> {
    const claimed = await this.claim();
    const stats: OutboxPublisherStats = { claimed: claimed.length, published: 0, deferred: 0, staleClaims: 0 };
    const pauseAfterClaim = process.env.WAGER_OUTBOX_TEST_ENABLE_FAULTS === 'true'
      ? Number.parseInt(process.env.WAGER_OUTBOX_TEST_PAUSE_AFTER_CLAIM_MS ?? '0', 10) : 0;
    if (Number.isSafeInteger(pauseAfterClaim) && pauseAfterClaim > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pauseAfterClaim, 60_000)));
    }
    const publicationResults = await Promise.allSettled(claimed.map(async (row) => withLogContext({
      ...(typeof row.payload.correlationId === 'string' ? { correlationId: row.payload.correlationId } : {}),
      ...(typeof (row.payload.data as Record<string, unknown> | undefined)?.transactionId === 'string'
        ? { transactionId: (row.payload.data as Record<string, string>).transactionId } : {}),
      walletId: row.aggregateId, eventId: row.id,
    }, async () => {
      try {
        const publishStartedAt = performance.now();
        await this.sqs.send(new SendMessageCommand({
          QueueUrl: this.options.queueUrl,
          MessageBody: JSON.stringify(row.payload),
          MessageGroupId: row.aggregateId,
          MessageDeduplicationId: row.id,
        }));
        const sentAt = new Date();
        const pauseAfterSend = process.env.WAGER_OUTBOX_TEST_ENABLE_FAULTS === 'true'
          ? Number.parseInt(process.env.WAGER_OUTBOX_TEST_PAUSE_AFTER_SEND_MS ?? '0', 10) : 0;
        if (Number.isSafeInteger(pauseAfterSend) && pauseAfterSend > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(pauseAfterSend, 60_000)));
        }
        const updated = await this.markPublished(row, sentAt);
        if (updated) {
          stats.published += 1;
          metrics.increment('outbox_publications_total', { outcome: 'success' });
          metrics.observe('outbox_publish_duration_seconds', Math.max(0, performance.now() - publishStartedAt) / 1_000, { outcome: 'success' });
          metrics.observe('outbox_event_age_seconds', Math.max(0, sentAt.getTime() - (date(row.occurredAt)?.getTime() ?? sentAt.getTime())) / 1_000);
          logEvent('outbox-publisher', 'outbox_event_published', { publisherId: this.options.publisherId,
            eventId: row.id, eventType: row.eventType, walletId: row.aggregateId, attempts: row.attempts });
        } else {
          stats.staleClaims += 1;
          logEvent('outbox-publisher', 'outbox_stale_claim_result', { publisherId: this.options.publisherId,
            eventId: row.id, walletId: row.aggregateId }, 'warn');
        }
      } catch (error) {
        const retryAt = new Date();
        const updated = await this.scheduleRetry(row, error, retryAt);
        if (updated) stats.deferred += 1;
        else stats.staleClaims += 1;
        if (updated) {
          metrics.increment('outbox_publications_total', { outcome: 'failure' });
          metrics.increment('outbox_publish_retries_total');
        }
        logEvent('outbox-publisher', updated ? 'outbox_publish_failed' : 'outbox_stale_claim_failure',
          { publisherId: this.options.publisherId, eventId: row.id, walletId: row.aggregateId, attempts: row.attempts + 1,
            errorCode: errorText(error) }, 'error');
      }
    })));
    const failedPublication = publicationResults.find((result) => result.status === 'rejected');
    if (failedPublication?.status === 'rejected') throw failedPublication.reason;
    return stats;
  }

  private async claim(): Promise<OutboxRow[]> {
    const batchSize = this.options.batchSize ?? 10;
    const leaseMs = this.options.leaseMs ?? 30_000;
    return this.orm.em.transactional(async (em) => {
      const rows = await em.execute<Array<Omit<OutboxRow, 'claimToken'>>>(
        `select candidate.id, candidate.aggregate_id as "aggregateId", candidate.event_type as "eventType",
          candidate.payload, candidate.occurred_at as "occurredAt", candidate.attempts,
          candidate.next_attempt_at as "nextAttemptAt", candidate.publication_order::text as "publicationOrder"
         from outbox_messages candidate
         where candidate.published_at is null
           and (candidate.next_attempt_at is null or candidate.next_attempt_at <= now())
           and (candidate.locked_until is null or candidate.locked_until <= now())
           and not exists (
             select 1 from outbox_messages earlier
             where earlier.aggregate_id = candidate.aggregate_id
               and earlier.published_at is null
               and earlier.publication_order < candidate.publication_order
           )
         order by candidate.publication_order
         limit ? for update of candidate skip locked`, [batchSize]);
      const claimed: OutboxRow[] = [];
      for (const row of rows) {
        const claimToken = `${this.options.publisherId}:${crypto.randomUUID()}`;
        const [updated] = await em.execute<Array<{ id: string }>>(
          `update outbox_messages set claimed_by = ?, locked_until = now() + (? * interval '1 millisecond')
           where id = ? and published_at is null and (locked_until is null or locked_until <= now()) returning id`,
          [claimToken, leaseMs, row.id]);
        if (updated) claimed.push({ ...row, claimToken });
      }
      return claimed;
    });
  }

  private async markPublished(row: OutboxRow, at: Date): Promise<boolean> {
    const [updated] = await this.orm.em.getConnection().execute<Array<{ id: string }>>(
      `update outbox_messages set published_at = ?, next_attempt_at = null, claimed_by = null, locked_until = null,
        last_error = null where id = ? and published_at is null and claimed_by = ? and locked_until > now() returning id`,
      [at, row.id, row.claimToken]);
    return Boolean(updated);
  }

  private async scheduleRetry(row: OutboxRow, error: unknown, at: Date): Promise<boolean> {
    const message = OutboxMessage.rehydrate({ id: row.id, aggregateId: row.aggregateId, eventType: row.eventType,
      payload: row.payload, occurredAt: date(row.occurredAt)!, attempts: row.attempts,
      ...(date(row.nextAttemptAt) ? { nextAttemptAt: date(row.nextAttemptAt)! } : {}) });
    message.scheduleRetry(at, { baseDelayMs: this.options.retryBaseMs ?? 1_000,
      maxDelayMs: this.options.retryMaximumMs ?? 60_000 });
    const [updated] = await this.orm.em.getConnection().execute<Array<{ id: string }>>(
      `update outbox_messages set attempts = ?, next_attempt_at = ?, claimed_by = null, locked_until = null, last_error = ?
       where id = ? and published_at is null and claimed_by = ? and locked_until > now() returning id`,
      [message.attempts, message.nextAttemptAt!, errorText(error), row.id, row.claimToken]);
    return Boolean(updated);
  }

  private retryDelayMs(attempt: number): number {
    return Math.min((this.options.retryBaseMs ?? 1_000) * (2 ** Math.min(attempt - 1, 30)), this.options.retryMaximumMs ?? 60_000);
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const stats = await this.runOnce();
        if (!stats.claimed && !this.stopping) await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 1_000));
      } catch (error) {
        logEvent('outbox-publisher', 'outbox_poll_error', { publisherId: this.options.publisherId,
          errorCode: errorText(error) }, 'error');
        if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 1_000));
      }
    }
  }
}

export function createOutboxSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}
