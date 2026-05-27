export interface CallSummary {
  id: string;
  provider: string;
  providerCallId: string | null;
  status: string;
  dialInNumber: string;
  conferenceName: string;
  streamUrl: string;
  startedAt: string;
  contextPreview: string;
  lastActivityAt: string;
}

export interface TranscriptSegment {
  id: string;
  callId: string;
  speaker: string;
  role: string;
  providerSpeakerLabel: string | null;
  text: string;
  isFinal: boolean;
  startedAtMs: number;
  endedAtMs: number;
  confidence: number | null;
  createdAt: string;
}

export interface Suggestion {
  id: string;
  callId: string;
  text: string;
  reason: string | null;
  priority: "low" | "medium" | "high" | null;
  competency: string | null;
  sourceSegmentIds: string[];
  createdAt: string;
}

export interface CallDetail extends CallSummary {
  providerCallLegId: string | null;
  providerCallSessionId: string | null;
  providerConferenceId: string | null;
  providerSessionId: string | null;
  contextPrompt: string;
  endedAt: string | null;
  transcript: TranscriptSegment[];
  suggestions: Suggestion[];
}

export interface TimelineTranscriptData {
  speaker?: string;
  role?: string;
  providerSpeakerLabel?: string | null;
  text?: string;
  isFinal?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
  confidence?: number | null;
  createdAt?: string;
}

export interface TimelineSuggestionData {
  text?: string;
  reason?: string | null;
  priority?: "low" | "medium" | "high" | null;
  competency?: string | null;
  sourceSegmentIds?: string[];
  createdAt?: string;
}

export interface CallUpdateData {
  id: string;
  provider: string;
  providerCallId: string | null;
  status: string;
  dialInNumber: string;
  conferenceName: string;
  startedAt: string;
  lastActivityAt: string;
  providerCallLegId: string | null;
  providerCallSessionId: string | null;
  providerConferenceId: string | null;
  providerSessionId: string | null;
  endedAt: string | null;
}

export interface TimelineTranscriptItem {
  id: string;
  type: "transcript";
  callId: string;
  sequence: number;
  occurredAt: string;
  data: TimelineTranscriptData;
}

export interface TimelineSuggestionItem {
  id: string;
  type: "suggestion";
  callId: string;
  sequence: number;
  occurredAt: string;
  data: TimelineSuggestionData;
}

export interface CallUpdateItem {
  id: string;
  type: "call_update";
  callId: string;
  sequence: number;
  occurredAt: string;
  data: CallUpdateData;
}

export type StreamEvent =
  | TimelineTranscriptItem
  | TimelineSuggestionItem
  | CallUpdateItem;
export type TimelineItem = TimelineTranscriptItem | TimelineSuggestionItem;
