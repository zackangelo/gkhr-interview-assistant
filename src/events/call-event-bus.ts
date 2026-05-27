import { randomUUID } from "node:crypto";

import type {
  Call,
  CallId,
  CallStatus,
  Provider,
  Suggestion,
  TranscriptSegment,
} from "../domain/types.js";

export type CallStreamEvent =
  | TranscriptStreamEvent
  | SuggestionStreamEvent
  | CallUpdateStreamEvent;

export interface CallUpdateStreamEvent {
  id: string;
  type: "call_update";
  callId: CallId;
  sequence: number;
  occurredAt: string;
  data: {
    id: string;
    provider: Provider;
    providerCallId: string | null;
    status: CallStatus;
    dialInNumber: string;
    conferenceName: string;
    startedAt: string;
    lastActivityAt: string;
    providerCallLegId: string | null;
    providerCallSessionId: string | null;
    providerConferenceId: string | null;
    providerSessionId: string | null;
    endedAt: string | null;
  };
}

export interface TranscriptStreamEvent {
  id: string;
  type: "transcript";
  callId: CallId;
  sequence: number;
  occurredAt: string;
  data: {
    segmentId: string;
    speaker: string;
    role: string;
    providerSpeakerLabel: string | null;
    text: string;
    isFinal: boolean;
    startedAtMs: number;
    endedAtMs: number;
    confidence: number | null;
    createdAt: string;
  };
}

export interface SuggestionStreamEvent {
  id: string;
  type: "suggestion";
  callId: CallId;
  sequence: number;
  occurredAt: string;
  data: {
    suggestionId: string;
    text: string;
    reason: string | null;
    priority: "low" | "medium" | "high" | null;
    competency: string | null;
    sourceSegmentIds: string[];
    createdAt: string;
  };
}

export interface CallEventSubscription extends AsyncIterable<CallStreamEvent> {
  close(): void;
}

export interface CallEventBus {
  publish(event: CallStreamEvent): void;
  publishCallUpdate(call: Call): CallStreamEvent;
  publishTranscript(segment: TranscriptSegment): CallStreamEvent;
  publishSuggestion(suggestion: Suggestion): CallStreamEvent;
  subscribe(callId: CallId): CallEventSubscription;
}

interface Subscriber {
  closed: boolean;
  queue: CallStreamEvent[];
  notify: () => void;
}

interface InMemoryCallEventBusOptions {
  createId?: () => string;
  now?: () => Date;
}

export class InMemoryCallEventBus implements CallEventBus {
  private readonly subscribers = new Map<CallId, Set<Subscriber>>();
  private readonly sequences = new Map<CallId, number>();
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(options: InMemoryCallEventBusOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  publish(event: CallStreamEvent): void {
    const subscribers = this.subscribers.get(event.callId);
    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber.queue.push(event);
      subscriber.notify();
    }
  }

  publishCallUpdate(call: Call): CallStreamEvent {
    const event: CallUpdateStreamEvent = {
      id: this.createId(),
      type: "call_update",
      callId: call.id,
      sequence: this.nextSequence(call.id),
      occurredAt: this.now().toISOString(),
      data: {
        id: call.id,
        provider: call.provider,
        providerCallId: call.providerCallId ?? null,
        status: call.status,
        dialInNumber: call.dialInNumber,
        conferenceName: call.conferenceName,
        startedAt: call.startedAt.toISOString(),
        lastActivityAt: call.lastActivityAt.toISOString(),
        providerCallLegId: call.providerCallLegId ?? null,
        providerCallSessionId: call.providerCallSessionId ?? null,
        providerConferenceId: call.providerConferenceId ?? null,
        providerSessionId: call.providerSessionId ?? null,
        endedAt: call.endedAt ? call.endedAt.toISOString() : null,
      },
    };

    this.publish(event);
    return event;
  }

  publishTranscript(segment: TranscriptSegment): CallStreamEvent {
    const event: TranscriptStreamEvent = {
      id: this.createId(),
      type: "transcript",
      callId: segment.callId,
      sequence: this.nextSequence(segment.callId),
      occurredAt: this.now().toISOString(),
      data: {
        segmentId: segment.id,
        speaker: segment.speaker,
        role: segment.role,
        providerSpeakerLabel: segment.providerSpeakerLabel ?? null,
        text: segment.text,
        isFinal: segment.isFinal,
        startedAtMs: segment.startedAtMs,
        endedAtMs: segment.endedAtMs,
        confidence: segment.confidence ?? null,
        createdAt: segment.createdAt.toISOString(),
      },
    };

    this.publish(event);
    return event;
  }

  publishSuggestion(suggestion: Suggestion): CallStreamEvent {
    const event: SuggestionStreamEvent = {
      id: this.createId(),
      type: "suggestion",
      callId: suggestion.callId,
      sequence: this.nextSequence(suggestion.callId),
      occurredAt: this.now().toISOString(),
      data: {
        suggestionId: suggestion.id,
        text: suggestion.text,
        reason: suggestion.reason ?? null,
        priority: suggestion.priority ?? null,
        competency: suggestion.competency ?? null,
        sourceSegmentIds: [...suggestion.sourceSegmentIds],
        createdAt: suggestion.createdAt.toISOString(),
      },
    };

    this.publish(event);
    return event;
  }

  subscribe(callId: CallId): CallEventSubscription {
    const subscriber: Subscriber = {
      closed: false,
      queue: [],
      notify: () => {},
    };
    const subscribers = this.subscribers.get(callId) ?? new Set<Subscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(callId, subscribers);

    return {
      [Symbol.asyncIterator]: () => this.createIterator(callId, subscriber),
      close: () => {
        subscriber.closed = true;
        subscriber.notify();
      },
    };
  }

  private async *createIterator(
    callId: CallId,
    subscriber: Subscriber,
  ): AsyncIterator<CallStreamEvent> {
    try {
      while (!subscriber.closed) {
        const event = subscriber.queue.shift();
        if (event) {
          yield event;
          continue;
        }

        await new Promise<void>((resolve) => {
          subscriber.notify = resolve;
        });
      }

      while (subscriber.queue.length > 0) {
        yield subscriber.queue.shift() as CallStreamEvent;
      }
    } finally {
      subscriber.closed = true;
      this.subscribers.get(callId)?.delete(subscriber);
      if (this.subscribers.get(callId)?.size === 0) {
        this.subscribers.delete(callId);
      }
    }
  }

  private nextSequence(callId: CallId): number {
    const sequence = (this.sequences.get(callId) ?? 0) + 1;
    this.sequences.set(callId, sequence);
    return sequence;
  }
}
