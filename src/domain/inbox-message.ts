import { fail, FailureCode } from './errors/domain-error';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private readonly receivedAtMs: number;
  private processedAtMs: number | undefined;

  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    receivedAt: Date,
    processedAt?: Date,
  ) {
    this.receivedAtMs = receivedAt.getTime();
    this.processedAtMs = processedAt?.getTime();
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName || !props.payloadHash) {
      fail(FailureCode.InvalidInboxMessage, 'Inbox message id, consumer name, and payload hash are required.');
    }
    const receivedAt = props.receivedAt ?? new Date();
    if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
      fail(FailureCode.InvalidInboxMessage, 'Inbox received time must be valid.');
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get receivedAt(): Date { return new Date(this.receivedAtMs); }
  get processedAt(): Date | undefined { return this.processedAtMs === undefined ? undefined : new Date(this.processedAtMs); }

  isProcessed(): boolean { return this.processedAtMs !== undefined; }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      fail(FailureCode.InvalidInboxMessage, 'An inbox message can only be marked processed once.');
    }
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      fail(FailureCode.InvalidInboxMessage, 'Inbox processed time must be valid.');
    }
    this.processedAtMs = at.getTime();
  }
}
