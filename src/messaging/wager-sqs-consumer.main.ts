import { createOrm } from '../persistence/orm';
import { ProcessWagerService } from '../wagering/process-wager.service';
import { createWagerSqsClient, WagerSqsConsumer } from './wager-sqs-consumer';

async function main(): Promise<void> {
  const queueUrl = process.env.SQS_COMMAND_QUEUE_URL;
  if (!queueUrl) throw new Error('SQS_COMMAND_QUEUE_URL is required.');
  const orm = await createOrm();
  const sqs = createWagerSqsClient();
  const consumer = new WagerSqsConsumer(new ProcessWagerService(orm), sqs, {
    queueUrl,
    consumerName: process.env.SQS_CONSUMER_NAME ?? 'distributed-wagering-processor-v1',
    visibilityTimeoutSeconds: Number.parseInt(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? '60', 10),
    waitTimeSeconds: 20,
    maxMessages: 10,
  });
  consumer.start();

  let shutdown: Promise<void> | undefined;
  const stop = () => {
    if (shutdown) return;
    shutdown = (async () => {
      process.stdout.write(`${JSON.stringify({ event: 'wager_sqs_shutdown_started', consumerName: process.env.SQS_CONSUMER_NAME ?? 'distributed-wagering-processor-v1' })}\n`);
      await consumer.stop();
      sqs.destroy();
      await orm.close(true);
      process.stdout.write(`${JSON.stringify({ event: 'wager_sqs_shutdown_complete' })}\n`);
    })();
    void shutdown.catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ event: 'wager_sqs_shutdown_failed',
        message: error instanceof Error ? error.message : 'Unknown shutdown error' })}\n`);
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: 'wager_sqs_startup_failed',
    message: error instanceof Error ? error.message : 'Unknown startup error' })}\n`);
  process.exitCode = 1;
});
