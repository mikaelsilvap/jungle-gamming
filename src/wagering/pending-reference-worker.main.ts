import { createOrm } from '../persistence/orm';
import { ProcessWagerService } from './process-wager.service';
import { PendingReferenceWorker } from './pending-reference.worker';
import { startDiagnosticServer } from '../observability/diagnostics-server';
import { metrics } from '../observability/metrics';
import { logEvent } from '../observability/logger';

async function main(): Promise<void> {
  const orm = await createOrm();
  const testLease = process.env.WAGER_TEST_ENABLE_FAULTS === 'true'
    ? Number.parseInt(process.env.WAGER_TEST_WORKER_LEASE_MS ?? '60_000', 10) : 60_000;
  const worker = new PendingReferenceWorker(new ProcessWagerService(orm), () => new Date(), 1_000,
    Number.isSafeInteger(testLease) && testLease > 0 ? testLease : 60_000);
  const diagnostics = startDiagnosticServer({ service: 'pending-reference-worker', port: Number(process.env.METRICS_PORT ?? 9102),
    registry: metrics, ready: async () => {
      try { await orm.em.getConnection().execute('select 1'); return true; } catch { return false; }
    } });
  worker.start();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    worker.stop();
    diagnostics.stop();
    await orm.close(true);
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

void main().catch((error: unknown) => {
  logEvent('pending-reference-worker', 'process_startup_failed', { errorCode: error && typeof error === 'object' && 'name' in error ? String(error.name) : 'UNKNOWN' }, 'error');
  process.exitCode = 1;
});
