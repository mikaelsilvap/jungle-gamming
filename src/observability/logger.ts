import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  eventId?: string;
}

const context = new AsyncLocalStorage<LogContext>();
const SAFE_ID = /^[\w.:-]{1,200}$/;

export function validCorrelationId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

export function withLogContext<T>(values: LogContext, work: () => T): T {
  const parent = context.getStore() ?? {};
  return context.run({ ...parent, ...values }, work);
}

export function currentLogContext(): LogContext {
  return context.getStore() ?? {};
}

export function requestCorrelationId(value: unknown): string {
  return validCorrelationId(value) ?? randomUUID();
}

export type LogLevel = 'info' | 'warn' | 'error';
const identifierFields = new Set(['correlationId', 'messageId', 'transactionId', 'walletId', 'providerId', 'eventId', 'publisherId', 'workerId', 'consumerName']);
const allowedFields = new Set([...identifierFields, 'durationMs', 'errorCode', 'status', 'kind', 'count', 'attempt', 'attempts', 'retryAfterSeconds', 'published', 'claimed', 'processed', 'rejected', 'rescheduled', 'skipped', 'route', 'method', 'statusCode', 'reason', 'pending', 'lagSeconds', 'eventType', 'operation', 'port']);

/** Writes allow-listed JSON fields only; request bodies, credentials, and raw errors are never serialized. */
export function serializeLogEvent(service: string, event: string, fields: Record<string, unknown> = {}, level: LogLevel = 'info',
  timestamp = new Date().toISOString()): string {
  const safe: Record<string, unknown> = {};
  const merged = { ...currentLogContext(), ...fields };
  for (const [key, value] of Object.entries(merged)) {
    if (!allowedFields.has(key) || value === undefined || value === null) continue;
    if (identifierFields.has(key)) {
      if (typeof value === 'string' && SAFE_ID.test(value)) safe[key] = value;
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
  }
  return JSON.stringify({ timestamp, level, service, event, ...safe });
}

export function logEvent(service: string, event: string, fields: Record<string, unknown> = {}, level: LogLevel = 'info'): void {
  const record = serializeLogEvent(service, event, fields, level);
  (level === 'error' ? process.stderr : process.stdout).write(`${record}\n`);
}
