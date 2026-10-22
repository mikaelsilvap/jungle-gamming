import { randomUUID } from 'node:crypto';
import { ProcessWagerService } from './process-wager.service';

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
      process.stdout.write(`${JSON.stringify({ event: 'pending_reference_claimed', workerId: this.workerId, count: ids.length })}\n`);
    }
    const pauseAfterClaim = process.env.WAGER_TEST_ENABLE_FAULTS === 'true'
      ? Number.parseInt(process.env.WAGER_TEST_PAUSE_AFTER_CLAIM_MS ?? '0', 10) : 0;
    if (ids.length && Number.isSafeInteger(pauseAfterClaim) && pauseAfterClaim > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pauseAfterClaim, 60_000)));
    }
    const summary: PendingWorkerSummary = { claimed: ids.length, processed: 0, rejected: 0, rescheduled: 0, skipped: 0 };
    for (const id of ids) {
      const result = await this.processor.resumePending(id, this.workerId, this.clock());
      summary[result] += 1;
    }
    return summary;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = true;
      void this.runOnce().then((summary) => {
        if (summary.claimed > 0) process.stdout.write(`${JSON.stringify({ event: 'pending_reference_batch', workerId: this.workerId, ...summary })}\n`);
      }).catch((error: unknown) => {
        process.stderr.write(`${JSON.stringify({ event: 'pending_reference_worker_error', workerId: this.workerId,
          message: error instanceof Error ? error.message : 'Unknown worker error' })}\n`);
      }).finally(() => { this.active = false; });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
