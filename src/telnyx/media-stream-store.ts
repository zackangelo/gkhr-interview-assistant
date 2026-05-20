import type { CallId } from "../domain/types.js";

export interface MediaStreamEventRecord {
  id: string;
  callId: CallId;
  receivedAt: Date;
  event: unknown;
}

export interface MediaStreamStore {
  recordEvent(record: MediaStreamEventRecord): Promise<void>;
  listEvents(callId: CallId): Promise<MediaStreamEventRecord[]>;
}

export class InMemoryMediaStreamStore implements MediaStreamStore {
  private readonly events = new Map<CallId, MediaStreamEventRecord[]>();

  async recordEvent(record: MediaStreamEventRecord): Promise<void> {
    const events = this.events.get(record.callId) ?? [];
    events.push(cloneRecord(record));
    this.events.set(record.callId, events.slice(-100));
  }

  async listEvents(callId: CallId): Promise<MediaStreamEventRecord[]> {
    return (this.events.get(callId) ?? []).map(cloneRecord);
  }
}

function cloneRecord(record: MediaStreamEventRecord): MediaStreamEventRecord {
  return {
    ...record,
    receivedAt: new Date(record.receivedAt),
  };
}
