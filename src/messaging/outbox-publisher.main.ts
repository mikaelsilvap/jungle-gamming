import { createOrm } from '../persistence/orm';
import { OutboxPublisher, createOutboxSqsClient } from './outbox-publisher';
import { HealthService } from '../health/health.service';
import { startDiagnosticServer } from '../observability/diagnostics-server';
import { metrics } from '../observability/metrics';
import { logEvent } from '../observability/logger';

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
  const health = new HealthService(orm, sqs, process.env.SQS_EVENTS_QUEUE_URL ?? '', process.env.SQS_DLQ_QUEUE_URL ?? '');
  const diagnostics = startDiagnosticServer({ service: 'outbox-publisher', port: Number(process.env.METRICS_PORT ?? 9103),
    registry: metrics, ready: async () => (await health.ready()).ready,
    sample: () => health.sampleOperationalGauges() });
  publisher.start();

  let shutdown: Promise<void> | undefined;
  const stop = () => {
    if (shutdown) return;
    shutdown = (async () => {
      logEvent('outbox-publisher', 'process_shutdown_started', { publisherId });
      await publisher.stop();
      diagnostics.stop();
      sqs.destroy();
      await orm.close(true);
      logEvent('outbox-publisher', 'process_shutdown_complete', { publisherId });
    })();
    void shutdown.catch((error: unknown) => {
      logEvent('outbox-publisher', 'process_shutdown_failed',
        { errorCode: error && typeof error === 'object' && 'name' in error ? String(error.name) : 'UNKNOWN' }, 'error');
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main().catch((error: unknown) => {
  logEvent('outbox-publisher', 'process_startup_failed',
    { errorCode: error && typeof error === 'object' && 'name' in error ? String(error.name) : 'UNKNOWN' }, 'error');
  process.exitCode = 1;
});
