import { fail, FailureCode } from './errors/domain-error';
import { IntegrationEvent } from './integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export class OutboxMessage {
  private readonly occurredAtMs: number;
  private _attempts: number;
  private nextAttemptAtMs: number | undefined;
  private publishedAtMs: number | undefined;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    occurredAt: Date,
    attempts: number,
    nextAttemptAt?: Date,
    publishedAt?: Date,
  ) {
    this.occurredAtMs = occurredAt.getTime();
    this._attempts = attempts;
    this.nextAttemptAtMs = nextAttemptAt?.getTime();
    this.publishedAtMs = publishedAt?.getTime();
  }

  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, Object.freeze(envelope), event.occurredAt, 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state.id, state.aggregateId, state.eventType, Object.freeze({ ...state.payload }),
      state.occurredAt, state.attempts, state.nextAttemptAt, state.publishedAt);
  }

  get attempts(): number { return this._attempts; }
  get occurredAt(): Date { return new Date(this.occurredAtMs); }
  get nextAttemptAt(): Date | undefined { return this.nextAttemptAtMs === undefined ? undefined : new Date(this.nextAttemptAtMs); }
  get publishedAt(): Date | undefined { return this.publishedAtMs === undefined ? undefined : new Date(this.publishedAtMs); }

  isPending(): boolean { return this.publishedAtMs === undefined; }

  isDue(now: Date): boolean {
    return this.isPending() && (this.nextAttemptAtMs === undefined || this.nextAttemptAtMs <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) fail(FailureCode.InvalidOutboxMessage, 'Published outbox messages are terminal.');
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      fail(FailureCode.InvalidOutboxMessage, 'Published time must be valid.');
    }
    if (!this.isDue(at)) {
      fail(FailureCode.InvalidOutboxMessage, 'Outbox message is not due for publication yet.');
    }
    this.publishedAtMs = at.getTime();
    this.nextAttemptAtMs = undefined;
  }

  scheduleRetry(now: Date, policy: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000 }): void {
    if (!this.isPending()) fail(FailureCode.InvalidOutboxMessage, 'Published outbox messages cannot be retried.');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())
      || !Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 1
      || !Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
      fail(FailureCode.InvalidOutboxMessage, 'Retry time and policy must be valid.');
    }
    if (!this.isDue(now)) {
      fail(FailureCode.InvalidOutboxMessage, 'A retry can only be scheduled after a due publication attempt.');
    }
    this._attempts += 1;
    const exponentialDelay = policy.baseDelayMs * (2 ** (this._attempts - 1));
    const delay = Math.min(exponentialDelay, policy.maxDelayMs);
    this.nextAttemptAtMs = now.getTime() + delay;
  }
}
