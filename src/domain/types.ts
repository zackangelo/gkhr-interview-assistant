export type CallId = string;
export type TranscriptSegmentId = string;
export type SuggestionId = string;

export type CallStatus =
  | "pending"
  | "ringing"
  | "active"
  | "completed"
  | "failed";

export type Provider = "telnyx";

export type SpeakerRole = "interviewer" | "candidate" | "unknown";

export interface CreateCallInput {
  contextPrompt: string;
  dialInNumber: string;
  conferenceName: string;
}

export interface Call {
  id: CallId;
  provider: Provider;
  dialInNumber: string;
  conferenceName: string;
  providerCallId?: string;
  providerCallLegId?: string;
  providerCallSessionId?: string;
  providerConferenceId?: string;
  providerSessionId?: string;
  status: CallStatus;
  contextPrompt: string;
  startedAt: Date;
  endedAt?: Date;
  lastActivityAt: Date;
}

export interface TranscriptSegment {
  id: TranscriptSegmentId;
  callId: CallId;
  speaker: string;
  role: SpeakerRole;
  providerSpeakerLabel?: string;
  text: string;
  isFinal: boolean;
  startedAtMs: number;
  endedAtMs: number;
  confidence?: number;
  createdAt: Date;
}

export interface Suggestion {
  id: SuggestionId;
  callId: CallId;
  text: string;
  reason?: string;
  priority?: "low" | "medium" | "high";
  competency?: string;
  sourceSegmentIds: TranscriptSegmentId[];
  createdAt: Date;
}

export interface CallSummary {
  callId: CallId;
  text: string;
  updatedAt: Date;
}
