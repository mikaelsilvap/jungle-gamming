import { createOrm } from '../persistence/orm';
import { ProcessWagerService } from '../wagering/process-wager.service';
import { createWagerSqsClient, WagerSqsConsumer } from './wager-sqs-consumer';
import { HealthService } from '../health/health.service';
import { startDiagnosticServer } from '../observability/diagnostics-server';
import { metrics } from '../observability/metrics';
import { logEvent } from '../observability/logger';

async function main(): Promise<void> {
  const queueUrl = process.env.SQS_COMMAND_QUEUE_URL;
  if (!queueUrl) throw new Error('SQS_COMMAND_QUEUE_URL is required.');
  const orm = await createOrm();
  const sqs = createWagerSqsClient();
  const consumer = new WagerSqsConsumer(new ProcessWagerService(orm), sqs, {
    queueUrl,
    consumerName: process.env.SQS_CONSUMER_NAME ?? 'distributed-wagering-processor-v1',
    visibilityTimeoutSeconds: Number.parseInt(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? '60', 10),
    maxReceiveCount: Number.parseInt(process.env.SQS_MAX_RECEIVE_COUNT ?? '5', 10),
    waitTimeSeconds: 20,
    maxMessages: 10,
  });
  const health = new HealthService(orm, sqs, queueUrl, process.env.SQS_DLQ_QUEUE_URL ?? '');
  const diagnostics = startDiagnosticServer({ service: 'sqs-consumer', port: Number(process.env.METRICS_PORT ?? 9101),
    registry: metrics, ready: async () => (await health.ready()).ready,
    sample: () => health.sampleOperationalGauges() });
  consumer.start();

  let shutdown: Promise<void> | undefined;
  const stop = () => {
    if (shutdown) return;
    shutdown = (async () => {
      logEvent('sqs-consumer', 'process_shutdown_started', { consumerName: process.env.SQS_CONSUMER_NAME ?? 'distributed-wagering-processor-v1' });
      await consumer.stop();
      diagnostics.stop();
      sqs.destroy();
      await orm.close(true);
      logEvent('sqs-consumer', 'process_shutdown_complete');
    })();
    void shutdown.catch((error: unknown) => {
      logEvent('sqs-consumer', 'process_shutdown_failed',
        { errorCode: error && typeof error === 'object' && 'name' in error ? String(error.name) : 'UNKNOWN' }, 'error');
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main().catch((error: unknown) => {
  logEvent('sqs-consumer', 'process_startup_failed',
    { errorCode: error && typeof error === 'object' && 'name' in error ? String(error.name) : 'UNKNOWN' }, 'error');
  process.exitCode = 1;
});
