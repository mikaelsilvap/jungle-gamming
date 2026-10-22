import { describe, expect, test } from 'bun:test';
import { currentLogContext, serializeLogEvent, withLogContext } from '../../src/observability/logger';
import { MetricRegistry } from '../../src/observability/metrics';

describe('observability primitives', () => {
  test('emits valid structured JSON with correlation fields and excludes payloads and credentials', () => {
    const record = serializeLogEvent('api', 'wager_processing_completed', {
      correlationId: 'corr-123', transactionId: 'tx-456', walletId: 'wallet-789', providerId: 'provider-a',
      password: 'super-secret', authorization: 'Bearer token', amount: '1000000.00', requestBody: { money: '100.00' },
    }, 'info', '2026-10-22T00:00:00.000Z');
    const parsed = JSON.parse(record) as Record<string, unknown>;
    expect(parsed).toEqual({ timestamp: '2026-10-22T00:00:00.000Z', level: 'info', service: 'api',
      event: 'wager_processing_completed', correlationId: 'corr-123', transactionId: 'tx-456',
      walletId: 'wallet-789', providerId: 'provider-a' });
    expect(record).not.toContain('super-secret');
    expect(record).not.toContain('1000000.00');
    expect(record).not.toContain('Bearer');
  });

  test('propagates correlation context across async work without inventing business IDs', async () => {
    await withLogContext({ correlationId: 'message-1', messageId: 'message-1' }, async () => {
      await Promise.resolve();
      expect(currentLogContext()).toEqual({ correlationId: 'message-1', messageId: 'message-1' });
    });
    expect(currentLogContext()).toEqual({});
  });

  test('renders counters, gauges and cumulative histogram buckets without high-cardinality labels', async () => {
    const registry = new MetricRegistry();
    registry.increment('wager_transactions_total', { status: 'PROCESSED', kind: 'BET' });
    registry.increment('wager_transactions_total', { status: 'REJECTED', kind: 'BET' });
    registry.increment('wager_duplicates_total', { operation: 'idempotency' });
    registry.increment('wager_duplicates_total', { operation: 'idempotency', walletId: 'must-not-be-a-label' } as never);
    registry.setGauge('outbox_pending_events', 3);
    registry.observe('wager_processing_duration_seconds', 0.04, { kind: 'BET' }, [0.01, 0.1, 1]);
    registry.observe('wager_processing_duration_seconds', 0.2, { kind: 'BET' }, [0.01, 0.1, 1]);
    const exposition = await registry.render();
    expect(exposition).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 1');
    expect(exposition).toContain('wager_duplicates_total{operation="idempotency"} 2');
    expect(exposition).not.toContain('must-not-be-a-label');
    expect(exposition).toContain('outbox_pending_events 3');
    expect(exposition).toContain('wager_processing_duration_seconds_bucket{kind="BET",le="0.1"} 1');
    expect(exposition).toContain('wager_processing_duration_seconds_bucket{kind="BET",le="+Inf"} 2');
    expect(exposition).toContain('wager_processing_duration_seconds_count{kind="BET"} 2');
  });
});
