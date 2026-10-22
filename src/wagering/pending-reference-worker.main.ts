import { createOrm } from '../persistence/orm';
import { ProcessWagerService } from './process-wager.service';
import { PendingReferenceWorker } from './pending-reference.worker';

async function main(): Promise<void> {
  const orm = await createOrm();
  const testLease = process.env.WAGER_TEST_ENABLE_FAULTS === 'true'
    ? Number.parseInt(process.env.WAGER_TEST_WORKER_LEASE_MS ?? '60_000', 10) : 60_000;
  const worker = new PendingReferenceWorker(new ProcessWagerService(orm), () => new Date(), 1_000,
    Number.isSafeInteger(testLease) && testLease > 0 ? testLease : 60_000);
  worker.start();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    worker.stop();
    await orm.close(true);
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: 'pending_reference_worker_startup_error',
    message: error instanceof Error ? error.message : 'Unknown worker startup error' })}\n`);
  process.exitCode = 1;
});
