import type { CallId } from "../domain/types.js";

export type TranscriptionAudioEncoding =
  | "mulaw"
  | "alaw"
  | "linear16"
  | "opus"
  | string;

export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
  startedAtMs: number;
  endedAtMs: number;
  confidence?: number;
  providerSpeakerLabel?: string;
}

export interface CreateTranscriptionSessionInput {
  callId: CallId;
  track: string;
  encoding: TranscriptionAudioEncoding;
  sampleRate: number;
  onTranscript(result: TranscriptionResult): void | Promise<void>;
  onError(error: Error): void | Promise<void>;
}

export interface TranscriptionSession {
  start(): Promise<void>;
  sendAudio(audio: Buffer): void;
  close(): void | Promise<void>;
}

export interface StreamingTranscriber {
  createSession(input: CreateTranscriptionSessionInput): TranscriptionSession;
}
