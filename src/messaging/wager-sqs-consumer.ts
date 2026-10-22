import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DomainError } from '../domain';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxMessageConflictError,
  ProcessWagerService,
} from '../wagering/process-wager.service';
import { InvalidWagerMessageError, parseWagerRequestEnvelope } from './wager-request-envelope';

export interface WagerSqsConsumerOptions {
  queueUrl: string;
  consumerName: string;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
  maxMessages?: number;
  retryBaseSeconds?: number;
  retryMaximumSeconds?: number;
}

export interface WagerSqsConsumerStats {
  received: number;
  acknowledged: number;
  inboxDuplicates: number;
  deferred: number;
}

function receiveCount(message: Message): number {
  const value = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function permanent(error: unknown): boolean {
  return error instanceof InvalidWagerMessageError
    || error instanceof InboxMessageConflictError
    || error instanceof IdempotencyConflictError
    || error instanceof ExternalTransactionConflictError
    || error instanceof DomainError;
}

/** Independent SQS FIFO adapter. PostgreSQL remains the financial correctness authority. */
export class WagerSqsConsumer {
  private stopping = false;
  private runPromise: Promise<void> | undefined;
  private static deleteFailureInjected = false;

  constructor(
    private readonly processor: ProcessWagerService,
    private readonly sqs: SQSClient,
    private readonly options: WagerSqsConsumerOptions,
  ) {
    if (!options.queueUrl || !options.consumerName) throw new Error('SQS queue URL and stable consumer name are required.');
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

  async runOnce(): Promise<WagerSqsConsumerStats> {
    const visibilityTimeout = this.options.visibilityTimeoutSeconds ?? 60;
    const received = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: this.options.queueUrl,
      MaxNumberOfMessages: this.options.maxMessages ?? 10,
      WaitTimeSeconds: this.options.waitTimeSeconds ?? 20,
      VisibilityTimeout: visibilityTimeout,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }));
    const messages = received.Messages ?? [];
    const stats: WagerSqsConsumerStats = { received: messages.length, acknowledged: 0, inboxDuplicates: 0, deferred: 0 };

    // FIFO can return multiple items from one group. Keep each group sequential while other groups advance.
    const groups = new Map<string, Message[]>();
    for (const [index, message] of messages.entries()) {
      const groupId = message.Attributes?.MessageGroupId ?? `unknown-group-${index}`;
      const group = groups.get(groupId) ?? [];
      group.push(message);
      groups.set(groupId, group);
    }
    await Promise.all([...groups.values()].map(async (group) => {
      for (const [index, message] of group.entries()) {
        const outcome = await this.processMessage(message, visibilityTimeout);
        if (outcome === 'acknowledged') stats.acknowledged += 1;
        else if (outcome === 'duplicate') { stats.acknowledged += 1; stats.inboxDuplicates += 1; }
        else {
          stats.deferred += 1;
          // Do not overtake a failed FIFO head with later messages from the same wallet group.
          for (const queued of group.slice(index + 1)) {
            if (!queued.ReceiptHandle) continue;
            await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.options.queueUrl,
              ReceiptHandle: queued.ReceiptHandle, VisibilityTimeout: 1 })).catch((error: unknown) => {
              process.stderr.write(`${JSON.stringify({ event: 'wager_sqs_group_tail_release_failed',
                messageId: queued.MessageId, message: error instanceof Error ? error.message : 'Unknown SQS error' })}\n`);
            });
            stats.deferred += 1;
          }
          break;
        }
      }
    }));
    return stats;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try { await this.runOnce(); }
      catch (error) {
        process.stderr.write(`${JSON.stringify({ event: 'wager_sqs_receive_error', consumerName: this.options.consumerName,
          message: error instanceof Error ? error.message : 'Unknown SQS error' })}\n`);
        if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private async processMessage(message: Message, visibilityTimeout: number): Promise<'acknowledged' | 'duplicate' | 'deferred'> {
    const receiptHandle = message.ReceiptHandle;
    if (!receiptHandle) {
      process.stderr.write(`${JSON.stringify({ event: 'wager_sqs_invalid_delivery', consumerName: this.options.consumerName,
        reason: 'missing_receipt_handle' })}\n`);
      return 'deferred';
    }
    const count = receiveCount(message);
    let parsed: ReturnType<typeof parseWagerRequestEnvelope>;
    try { parsed = parseWagerRequestEnvelope(message.Body); }
    catch (error) {
      await this.defer(message, receiptHandle, count, error, permanent(error));
      return 'deferred';
    }
    const messageGroupId = message.Attributes?.MessageGroupId;
    if (messageGroupId && messageGroupId !== parsed.input.walletId) {
      process.stderr.write(`${JSON.stringify({ event: 'wager_sqs_group_wallet_mismatch', consumerName: this.options.consumerName,
        messageId: parsed.envelope.messageId, walletId: parsed.input.walletId, messageGroupId })}\n`);
    }

    const heartbeatMs = Math.max(1_000, Math.floor(visibilityTimeout * 500));
    const heartbeat = setInterval(() => {
      void this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.options.queueUrl,
        ReceiptHandle: receiptHandle, VisibilityTimeout: visibilityTimeout })).catch((error: unknown) => {
        process.stderr.write(`${JSON.stringify({ event: 'wager_sqs_visibility_renewal_failed', consumerName: this.options.consumerName,
          messageId: parsed.envelope.messageId, message: error instanceof Error ? error.message : 'Unknown SQS error' })}\n`);
      });
    }, heartbeatMs);

    try {
      const outcome = await this.processor.processFromInbox(parsed.input, parsed.idempotencyKey, {
        consumerName: this.options.consumerName, messageId: parsed.envelope.messageId, payloadHash: parsed.payloadHash,
      });
      const pauseMs = process.env.WAGER_TEST_ENABLE_FAULTS === 'true'
        ? Number.parseInt(process.env.WAGER_TEST_PAUSE_AFTER_COMMIT_MS ?? '0', 10) : 0;
      if (Number.isSafeInteger(pauseMs) && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(pauseMs, 60_000)));
      if (process.env.WAGER_TEST_ENABLE_FAULTS === 'true' && process.env.WAGER_TEST_FAIL_DELETE_ONCE === 'true'
        && !WagerSqsConsumer.deleteFailureInjected) {
        WagerSqsConsumer.deleteFailureInjected = true;
        throw new Error('Injected DeleteMessage failure after database commit.');
      }
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: receiptHandle }));
      const messageId = parsed.envelope.messageId;
      if (outcome.duplicate) {
        process.stdout.write(`${JSON.stringify({ event: 'wager_sqs_inbox_duplicate', consumerName: this.options.consumerName, messageId })}\n`);
        return 'duplicate';
      }
      process.stdout.write(`${JSON.stringify({ event: 'wager_sqs_processed', consumerName: this.options.consumerName, messageId,
        transactionId: outcome.result.transactionId, walletId: parsed.input.walletId, providerId: parsed.input.providerId,
        status: outcome.result.status, idempotentReplay: outcome.result.idempotentReplay })}\n`);
      return 'acknowledged';
    } catch (error) {
      await this.defer(message, receiptHandle, count, error, permanent(error));
      return 'deferred';
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async defer(message: Message, receiptHandle: string, count: number, error: unknown, isPermanent: boolean): Promise<void> {
    const base = this.options.retryBaseSeconds ?? 1;
    const maximum = this.options.retryMaximumSeconds ?? 30;
    const delay = Math.min(base * (2 ** Math.min(count - 1, 10)), maximum);
    try {
      await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.options.queueUrl,
        ReceiptHandle: receiptHandle, VisibilityTimeout: delay }));
    } catch (visibilityError) {
      process.stderr.write(`${JSON.stringify({ event: 'wager_sqs_visibility_update_failed', consumerName: this.options.consumerName,
        messageId: message.MessageId, message: visibilityError instanceof Error ? visibilityError.message : 'Unknown SQS error' })}\n`);
    }
    process.stderr.write(`${JSON.stringify({ event: isPermanent ? 'wager_sqs_poison_message' : 'wager_sqs_retry_scheduled',
      consumerName: this.options.consumerName, messageId: message.MessageId, receiveCount: count, retryAfterSeconds: delay,
      errorCode: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
      message: error instanceof Error ? error.message : 'Unknown processing error' })}\n`);
  }
}

export function createWagerSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}
