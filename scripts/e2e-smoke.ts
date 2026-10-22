import { randomUUID } from 'node:crypto';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const baseUrl = `http://127.0.0.1:${process.env.API_PORT ?? process.env.API_HOST_PORT ?? '23000'}`;
const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:24566';
const commandQueueUrl = process.env.SQS_COMMAND_QUEUE_URL!;
const eventsQueueUrl = process.env.SQS_EVENTS_QUEUE_URL!;
const sqs = new SQSClient({ endpoint, region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
  maxAttempts: 1 });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(description: string, probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function submit(input: Record<string, unknown>, key: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(input) });
  const body = await response.json() as Record<string, unknown>;
  assert(response.status === 200, `Expected HTTP 200, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main(): Promise<void> {
try {
  const playerId = randomUUID();
  const opened = await fetch(`${baseUrl}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }) });
  assert(opened.status === 201, `Wallet opening returned HTTP ${opened.status}.`);
  const wallet = await opened.json() as { id: string; balance: { amount: string }; version: number };
  const common = { providerId: `validation-${playerId}`, playerId, walletId: wallet.id,
    roundId: `round-${playerId}`, gameId: 'clean-room-validation', money: { amount: '20.00', currency: 'BRL' } };
  const bet = await submit({ ...common, externalTransactionId: 'bet', kind: 'BET' }, `key-${playerId}-bet`);
  assert((bet.balance as { amount: string }).amount === '80.00', 'BET balance mismatch.');
  const win = await submit({ ...common, money: { amount: '5.00', currency: 'BRL' },
    externalTransactionId: 'win', kind: 'WIN', referenceExternalTransactionId: 'bet' }, `key-${playerId}-win`);
  assert((win.balance as { amount: string }).amount === '85.00', 'WIN balance mismatch.');
  const loss = await submit({ ...common, externalTransactionId: 'loss', kind: 'LOSS' }, `key-${playerId}-loss`);
  assert((loss.balance as { amount: string }).amount === '85.00', 'LOSS changed the balance.');
  const refund = await submit({ ...common, externalTransactionId: 'refund', kind: 'REFUND',
    referenceExternalTransactionId: 'bet' }, `key-${playerId}-refund`);
  assert((refund.balance as { amount: string }).amount === '105.00', 'REFUND balance mismatch.');
  const rollback = await submit({ ...common, money: { amount: '5.00', currency: 'BRL' },
    externalTransactionId: 'rollback', kind: 'ROLLBACK', referenceExternalTransactionId: 'win' }, `key-${playerId}-rollback`);
  assert((rollback.balance as { amount: string }).amount === '100.00', 'ROLLBACK balance mismatch.');

  const reconciliation = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
  const reconciled = await reconciliation.json() as { consistent: boolean; storedBalance: { amount: string }; calculatedBalance: { amount: string }; checkedEntries: number };
  assert(reconciliation.ok && reconciled.consistent && reconciled.storedBalance.amount === '100.00'
    && reconciled.calculatedBalance.amount === '100.00' && reconciled.checkedEntries === 5,
  'HTTP financial operations did not reconcile to five ledger entries.');
  console.log('PASS HTTP BET, WIN, LOSS, REFUND, ROLLBACK; final balance 100.00 BRL; 5 ledger rows reconciled.');

  const externalTransactionId = `sqs-${randomUUID()}`;
  const sqsPayload = { messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { providerId: common.providerId, externalTransactionId, idempotencyKey: `key-${externalTransactionId}`,
      playerId, walletId: wallet.id, roundId: common.roundId, gameId: common.gameId, kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' } } };
  await sqs.send(new SendMessageCommand({ QueueUrl: commandQueueUrl, MessageBody: JSON.stringify(sqsPayload),
    MessageGroupId: wallet.id, MessageDeduplicationId: sqsPayload.messageId }));
  const sqsResult = await waitFor('SQS wager commit', async () => {
    const response = await fetch(`${baseUrl}/providers/${common.providerId}/wagering/transactions/${externalTransactionId}`);
    if (response.status === 404) return undefined;
    assert(response.ok, `SQS wager query returned HTTP ${response.status}.`);
    return await response.json() as { transactionId: string; status: string; balance: { amount: string } };
  });
  assert(sqsResult.status === 'PROCESSED' && sqsResult.balance.amount === '99.00', 'SQS wager result mismatch.');
  const postSqsReconciliation = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' })
    .then((response) => response.json()) as { consistent: boolean; storedBalance: { amount: string } };
  assert(postSqsReconciliation.consistent && postSqsReconciliation.storedBalance.amount === '99.00', 'SQS ledger reconciliation failed.');

  const published = await waitFor('outbox event in SQS', async () => {
    const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: eventsQueueUrl, MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1, VisibilityTimeout: 2 }));
    let matching: { eventType: string; data: { transactionId: string } } | undefined;
    for (const message of result.Messages ?? []) {
      try {
        const event = JSON.parse(message.Body ?? '{}') as { eventType?: string; data?: { transactionId?: string } };
        if (event.eventType === 'WagerTransactionProcessed' && event.data?.transactionId === sqsResult.transactionId) {
          matching = event as { eventType: string; data: { transactionId: string } };
        }
      } finally {
        // Drain earlier FIFO messages so they cannot block delivery of the event under test.
        if (message.ReceiptHandle) await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsQueueUrl,
          ReceiptHandle: message.ReceiptHandle }));
      }
    }
    return matching;
  });
  assert(published.eventType === 'WagerTransactionProcessed', 'Expected processed wager event in the event queue.');
  console.log('PASS SQS command consumer, committed wager, reconciled ledger, and published transactional outbox event.');
} finally {
  sqs.destroy();
}
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'End-to-end validation failed.');
  process.exitCode = 1;
});
