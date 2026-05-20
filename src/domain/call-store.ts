import type {
  Call,
  CallId,
  CallSummary,
  CreateCallInput,
  Suggestion,
  TranscriptSegment,
} from "./types.js";

export interface CallStore {
  createCall(input: CreateCallInput): Promise<Call>;
  getCall(callId: CallId): Promise<Call | null>;
  listCalls(): Promise<Call[]>;
  updateCall(callId: CallId, patch: Partial<Call>): Promise<Call>;
  appendTranscriptSegment(segment: TranscriptSegment): Promise<void>;
  upsertTranscriptSegment(segment: TranscriptSegment): Promise<void>;
  listTranscriptSegments(callId: CallId): Promise<TranscriptSegment[]>;
  appendSuggestion(suggestion: Suggestion): Promise<void>;
  listSuggestions(callId: CallId): Promise<Suggestion[]>;
  upsertSummary(summary: CallSummary): Promise<void>;
  getSummary(callId: CallId): Promise<CallSummary | null>;
}
