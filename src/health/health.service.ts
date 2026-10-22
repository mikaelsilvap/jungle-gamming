import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { metrics } from '../observability/metrics';

const PROBE_TIMEOUT_MS = 2_000;

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Health probe timed out.')), PROBE_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export class HealthService {
  constructor(private readonly orm: MikroORM, private readonly sqs: SQSClient,
    private readonly commandQueueUrl: string, private readonly dlqQueueUrl: string) {}

  async checkPostgres(): Promise<boolean> {
    try { await bounded(this.orm.em.getConnection().execute('select 1')); metrics.setGauge('dependency_up', 1, { operation: 'postgres' }); return true; }
    catch { metrics.setGauge('dependency_up', 0, { operation: 'postgres' }); return false; }
  }

  async checkSqs(): Promise<boolean> {
    if (!this.commandQueueUrl) { metrics.setGauge('dependency_up', 0, { operation: 'sqs' }); return false; }
    try {
      await bounded(this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.commandQueueUrl, AttributeNames: ['QueueArn'] })));
      metrics.setGauge('dependency_up', 1, { operation: 'sqs' }); return true;
    } catch { metrics.setGauge('dependency_up', 0, { operation: 'sqs' }); return false; }
  }

  async ready(): Promise<{ ready: boolean; postgres: boolean; sqs: boolean }> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    return { ready: postgres && sqs, postgres, sqs };
  }

  async sampleOperationalGauges(): Promise<void> {
    try {
      const [row] = await bounded(this.orm.em.getConnection().execute<Array<{ pending: string; lag: string | null }>>(
        `select count(*) filter (where published_at is null)::text as pending,
          extract(epoch from (now() - min(occurred_at) filter (where published_at is null)))::text as lag
         from outbox_messages`));
      metrics.setGauge('outbox_pending_events', Number(row?.pending ?? 0));
      metrics.setGauge('outbox_lag_seconds', Number(row?.lag ?? 0));
      metrics.setGauge('dependency_up', 1, { operation: 'postgres' });
    } catch { metrics.setGauge('dependency_up', 0, { operation: 'postgres' }); }
    if (this.dlqQueueUrl) {
      try {
        const result = await bounded(this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.dlqQueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] })));
        const count = Number(result.Attributes?.ApproximateNumberOfMessages ?? 0)
          + Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
        metrics.setGauge('sqs_dlq_messages', count);
      } catch { metrics.setGauge('sqs_dlq_messages', 0); metrics.setGauge('dependency_up', 0, { operation: 'sqs' }); }
    }
  }
}
