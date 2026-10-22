import { randomUUID } from 'node:crypto';
import { ProcessWagerService } from './process-wager.service';
import { logEvent, withLogContext } from '../observability/logger';
import { metrics } from '../observability/metrics';

export interface PendingWorkerSummary {
  claimed: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
}

/** PostgreSQL-leased poller; process crashes release work when the lease expires. */
export class PendingReferenceWorker {
  readonly workerId = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;

  constructor(
    private readonly processor: ProcessWagerService,
    private readonly clock: () => Date = () => new Date(),
    private readonly pollIntervalMs = 1_000,
    private readonly leaseMs = 60_000,
    private readonly batchSize = 10,
  ) {}

  async runOnce(now = this.clock()): Promise<PendingWorkerSummary> {
    const ids = await this.processor.claimPending(this.workerId, now, this.leaseMs, this.batchSize);
    if (ids.length > 0) {
      logEvent('pending-reference-worker', 'pending_reference_claimed', { workerId: this.workerId, count: ids.length });
    }
    const pauseAfterClaim = process.env.WAGER_TEST_ENABLE_FAULTS === 'true'
      ? Number.parseInt(process.env.WAGER_TEST_PAUSE_AFTER_CLAIM_MS ?? '0', 10) : 0;
    if (ids.length && Number.isSafeInteger(pauseAfterClaim) && pauseAfterClaim > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pauseAfterClaim, 60_000)));
    }
    const summary: PendingWorkerSummary = { claimed: ids.length, processed: 0, rejected: 0, rescheduled: 0, skipped: 0 };
    for (const id of ids) {
      const startedAt = performance.now();
      const result = await withLogContext({ correlationId: id, transactionId: id }, () => this.processor.resumePending(id, this.workerId, this.clock()));
      summary[result] += 1;
      metrics.increment('pending_reference_outcomes_total', { outcome: result });
      if (result === 'rescheduled') metrics.increment('pending_reference_retries_total');
      metrics.observe('pending_reference_processing_duration_seconds', Math.max(0, performance.now() - startedAt) / 1_000,
        { outcome: result });
      if (result === 'processed' || result === 'rejected') logEvent('pending-reference-worker', 'pending_reference_recovered',
        { workerId: this.workerId, transactionId: id, status: result === 'processed' ? 'PROCESSED' : 'REJECTED' });
    }
    return summary;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = true;
      void this.runOnce().then((summary) => {
        if (summary.claimed > 0) logEvent('pending-reference-worker', 'pending_reference_batch', { workerId: this.workerId, ...summary });
      }).catch((error: unknown) => {
        metrics.increment('pending_reference_worker_errors_total');
        logEvent('pending-reference-worker', 'pending_reference_worker_error', { workerId: this.workerId,
          errorCode: error && typeof error === 'object' && 'name' in error ? String(error.name) : 'UNKNOWN' }, 'error');
      }).finally(() => { this.active = false; });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
