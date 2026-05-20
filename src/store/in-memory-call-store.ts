import { randomUUID } from "node:crypto";

import type { CallStore } from "../domain/call-store.js";
import type {
  Call,
  CallId,
  CallSummary,
  CreateCallInput,
  Suggestion,
  TranscriptSegment,
} from "../domain/types.js";

interface InMemoryCallStoreOptions {
  createId?: () => string;
  now?: () => Date;
}

export class CallNotFoundError extends Error {
  constructor(callId: CallId) {
    super(`Call not found: ${callId}`);
    this.name = "CallNotFoundError";
  }
}

export class InMemoryCallStore implements CallStore {
  private readonly calls = new Map<CallId, Call>();
  private readonly transcriptSegments = new Map<CallId, TranscriptSegment[]>();
  private readonly suggestions = new Map<CallId, Suggestion[]>();
  private readonly summaries = new Map<CallId, CallSummary>();
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(options: InMemoryCallStoreOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async createCall(input: CreateCallInput): Promise<Call> {
    const now = this.now();
    const call: Call = {
      id: this.createId(),
      provider: "telnyx",
      dialInNumber: input.dialInNumber,
      conferenceName: input.conferenceName,
      providerCallLegs: [],
      status: "pending",
      contextPrompt: input.contextPrompt,
      startedAt: now,
      lastActivityAt: now,
    };

    this.calls.set(call.id, cloneCall(call));
    return cloneCall(call);
  }

  async getCall(callId: CallId): Promise<Call | null> {
    const call = this.calls.get(callId);
    return call ? cloneCall(call) : null;
  }

  async listCalls(): Promise<Call[]> {
    return [...this.calls.values()]
      .sort(
        (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
      )
      .map(cloneCall);
  }

  async updateCall(callId: CallId, patch: Partial<Call>): Promise<Call> {
    const currentCall = this.calls.get(callId);
    if (!currentCall) {
      throw new CallNotFoundError(callId);
    }

    const updatedCall: Call = {
      ...currentCall,
      ...patch,
      id: currentCall.id,
      provider: currentCall.provider,
      lastActivityAt: patch.lastActivityAt ?? this.now(),
    };

    this.calls.set(callId, cloneCall(updatedCall));
    return cloneCall(updatedCall);
  }

  async appendTranscriptSegment(segment: TranscriptSegment): Promise<void> {
    await this.upsertTranscriptSegment(segment);
  }

  async upsertTranscriptSegment(segment: TranscriptSegment): Promise<void> {
    await this.assertCallExists(segment.callId);

    const segments = this.transcriptSegments.get(segment.callId) ?? [];
    const existingIndex = segments.findIndex(
      (currentSegment) => currentSegment.id === segment.id,
    );
    if (existingIndex >= 0) {
      segments[existingIndex] = cloneTranscriptSegment(segment);
    } else {
      segments.push(cloneTranscriptSegment(segment));
    }

    segments.sort((left, right) => left.startedAtMs - right.startedAtMs);
    this.transcriptSegments.set(segment.callId, segments);
    await this.touchCall(segment.callId);
  }

  async listTranscriptSegments(callId: CallId): Promise<TranscriptSegment[]> {
    await this.assertCallExists(callId);
    return (this.transcriptSegments.get(callId) ?? []).map(
      cloneTranscriptSegment,
    );
  }

  async appendSuggestion(suggestion: Suggestion): Promise<void> {
    await this.assertCallExists(suggestion.callId);

    const suggestions = this.suggestions.get(suggestion.callId) ?? [];
    suggestions.push(cloneSuggestion(suggestion));
    suggestions.sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    this.suggestions.set(suggestion.callId, suggestions);
    await this.touchCall(suggestion.callId);
  }

  async listSuggestions(callId: CallId): Promise<Suggestion[]> {
    await this.assertCallExists(callId);
    return (this.suggestions.get(callId) ?? []).map(cloneSuggestion);
  }

  async upsertSummary(summary: CallSummary): Promise<void> {
    await this.assertCallExists(summary.callId);
    this.summaries.set(summary.callId, cloneSummary(summary));
    await this.touchCall(summary.callId);
  }

  async getSummary(callId: CallId): Promise<CallSummary | null> {
    await this.assertCallExists(callId);
    const summary = this.summaries.get(callId);
    return summary ? cloneSummary(summary) : null;
  }

  private async assertCallExists(callId: CallId): Promise<void> {
    if (!this.calls.has(callId)) {
      throw new CallNotFoundError(callId);
    }
  }

  private async touchCall(callId: CallId): Promise<void> {
    await this.updateCall(callId, {
      lastActivityAt: this.now(),
    });
  }
}

function cloneCall(call: Call): Call {
  return {
    ...call,
    providerCallLegs: call.providerCallLegs.map((leg) => ({
      ...leg,
      createdAt: new Date(leg.createdAt),
      answeredAt: leg.answeredAt ? new Date(leg.answeredAt) : undefined,
      endedAt: leg.endedAt ? new Date(leg.endedAt) : undefined,
    })),
    startedAt: new Date(call.startedAt),
    endedAt: call.endedAt ? new Date(call.endedAt) : undefined,
    lastActivityAt: new Date(call.lastActivityAt),
  };
}

function cloneTranscriptSegment(segment: TranscriptSegment): TranscriptSegment {
  return {
    ...segment,
    createdAt: new Date(segment.createdAt),
  };
}

function cloneSuggestion(suggestion: Suggestion): Suggestion {
  return {
    ...suggestion,
    sourceSegmentIds: [...suggestion.sourceSegmentIds],
    createdAt: new Date(suggestion.createdAt),
  };
}

function cloneSummary(summary: CallSummary): CallSummary {
  return {
    ...summary,
    updatedAt: new Date(summary.updatedAt),
  };
}
