import { createOrm } from '../persistence/orm';
import { OutboxPublisher, createOutboxSqsClient } from './outbox-publisher';

async function main(): Promise<void> {
  const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;
  if (!queueUrl) throw new Error('SQS_EVENTS_QUEUE_URL is required.');
  const publisherId = process.env.OUTBOX_PUBLISHER_ID || process.env.HOSTNAME || `outbox-${crypto.randomUUID()}`;
  const orm = await createOrm();
  const sqs = createOutboxSqsClient();
  const publisher = new OutboxPublisher(orm, sqs, {
    queueUrl,
    publisherId,
    batchSize: Number.parseInt(process.env.OUTBOX_BATCH_SIZE ?? '10', 10),
    leaseMs: Number.parseInt(process.env.OUTBOX_LEASE_MS ?? '30000', 10),
    retryBaseMs: Number.parseInt(process.env.OUTBOX_RETRY_BASE_MS ?? '1000', 10),
    retryMaximumMs: Number.parseInt(process.env.OUTBOX_RETRY_MAXIMUM_MS ?? '60000', 10),
    pollIntervalMs: Number.parseInt(process.env.OUTBOX_POLL_INTERVAL_MS ?? '1000', 10),
  });
  publisher.start();

  let shutdown: Promise<void> | undefined;
  const stop = () => {
    if (shutdown) return;
    shutdown = (async () => {
      process.stdout.write(`${JSON.stringify({ event: 'outbox_shutdown_started', publisherId })}\n`);
      await publisher.stop();
      sqs.destroy();
      await orm.close(true);
      process.stdout.write(`${JSON.stringify({ event: 'outbox_shutdown_complete' })}\n`);
    })();
    void shutdown.catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ event: 'outbox_shutdown_failed',
        error: error instanceof Error ? error.message : 'Unknown shutdown error' })}\n`);
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: 'outbox_startup_failed',
    error: error instanceof Error ? error.message : 'Unknown startup error' })}\n`);
  process.exitCode = 1;
});
