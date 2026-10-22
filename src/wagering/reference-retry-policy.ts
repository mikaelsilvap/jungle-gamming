export interface ReferenceRetrySettings {
  baseDelayMs: number;
  maximumDelayMs: number;
  timeToLiveMs: number;
  maximumAttempts: number;
}

export const DEFAULT_REFERENCE_RETRY_SETTINGS: Readonly<ReferenceRetrySettings> = Object.freeze({
  baseDelayMs: 60_000,
  maximumDelayMs: 1_800_000,
  timeToLiveMs: 86_400_000,
  maximumAttempts: 64,
});

/** Pure policy; callers inject `now` so scheduling is deterministic in tests. */
export class ReferenceRetryPolicy {
  constructor(readonly settings: ReferenceRetrySettings = DEFAULT_REFERENCE_RETRY_SETTINGS) {
    if (!Number.isSafeInteger(settings.baseDelayMs) || settings.baseDelayMs < 1
      || !Number.isSafeInteger(settings.maximumDelayMs) || settings.maximumDelayMs < settings.baseDelayMs
      || !Number.isSafeInteger(settings.timeToLiveMs) || settings.timeToLiveMs < settings.maximumDelayMs
      || !Number.isSafeInteger(settings.maximumAttempts) || settings.maximumAttempts < 1) {
      throw new Error('Reference retry settings are invalid.');
    }
  }

  expiresAt(createdAt: Date): Date {
    this.assertDate(createdAt);
    return new Date(createdAt.getTime() + this.settings.timeToLiveMs);
  }

  initialAttemptAt(createdAt: Date): Date {
    this.assertDate(createdAt);
    return new Date(Math.min(createdAt.getTime() + this.settings.baseDelayMs, this.expiresAt(createdAt).getTime()));
  }

  nextAttemptAt(now: Date, attemptsAfterFailure: number, expiresAt: Date): Date {
    this.assertDate(now);
    this.assertDate(expiresAt);
    if (!Number.isSafeInteger(attemptsAfterFailure) || attemptsAfterFailure < 1) throw new Error('Attempt count must be positive.');
    const exponent = Math.min(attemptsAfterFailure, 30);
    const delay = Math.min(this.settings.baseDelayMs * (2 ** exponent), this.settings.maximumDelayMs);
    return new Date(Math.min(now.getTime() + delay, expiresAt.getTime()));
  }

  isExpired(now: Date, expiresAt: Date): boolean {
    this.assertDate(now);
    this.assertDate(expiresAt);
    return now.getTime() >= expiresAt.getTime();
  }

  hasExhaustedAttempts(attempts: number): boolean {
    return attempts >= this.settings.maximumAttempts;
  }

  private assertDate(value: Date): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('A valid time is required.');
  }
}
