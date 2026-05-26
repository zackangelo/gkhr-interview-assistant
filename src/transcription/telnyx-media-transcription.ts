import type { CallStore } from "../domain/call-store.js";
import type { TranscriptSegment } from "../domain/types.js";
import type { CallEventBus } from "../events/call-event-bus.js";
import type { SuggestionEngine } from "../suggestions/suggestion-engine.js";
import type {
  StreamingTranscriber,
  TranscriptionAudioEncoding,
  TranscriptionResult,
  TranscriptionSession,
} from "./transcriber.js";

interface TelnyxMediaTranscriptionSessionInput {
  callId: string;
  callStore: CallStore;
  eventBus: CallEventBus;
  transcriber: StreamingTranscriber | null;
  suggestionEngine?: SuggestionEngine | null;
  now?: () => Date;
}

interface MediaFormat {
  encoding: TranscriptionAudioEncoding;
  sampleRate: number;
}

interface ActiveTrackSession {
  session: TranscriptionSession;
  startPromise: Promise<void>;
}

interface TelnyxStartEvent {
  event: "start";
  start?: {
    media_format?: {
      encoding?: unknown;
      sample_rate?: unknown;
    };
  };
}

interface TelnyxMediaEvent {
  event: "media";
  media?: {
    track?: unknown;
    payload?: unknown;
  };
}

interface TelnyxStopEvent {
  event: "stop";
}

type TelnyxStreamEvent = TelnyxStartEvent | TelnyxMediaEvent | TelnyxStopEvent;

const defaultMediaFormat: MediaFormat = {
  encoding: "mulaw",
  sampleRate: 8000,
};

export class TelnyxMediaTranscriptionSession {
  private readonly trackSessions = new Map<string, ActiveTrackSession>();
  private readonly now: () => Date;
  private mediaFormat: MediaFormat = defaultMediaFormat;
  private closed = false;

  constructor(private readonly input: TelnyxMediaTranscriptionSessionInput) {
    this.now = input.now ?? (() => new Date());
  }

  async handleEvent(event: unknown): Promise<void> {
    const telnyxEvent = parseTelnyxStreamEvent(event);
    if (!telnyxEvent || this.closed) {
      return;
    }

    if (telnyxEvent.event === "start") {
      this.mediaFormat = readMediaFormat(telnyxEvent);
      return;
    }

    if (telnyxEvent.event === "stop") {
      await this.close();
      return;
    }

    await this.handleMediaEvent(telnyxEvent);
  }

  async close(): Promise<void> {
    this.closed = true;
    const activeSessions = [...this.trackSessions.values()];
    this.trackSessions.clear();

    await Promise.all(
      activeSessions.map(async (activeSession) => {
        await activeSession.startPromise.catch(() => undefined);
        await activeSession.session.close();
      }),
    );
  }

  private async handleMediaEvent(event: TelnyxMediaEvent): Promise<void> {
    const payload = readString(event.media?.payload);
    if (!payload) {
      return;
    }

    const track = normalizeTrack(event.media?.track);
    const activeSession = this.ensureTrackSession(track);
    if (!activeSession) {
      return;
    }

    await activeSession.startPromise;
    activeSession.session.sendAudio(Buffer.from(payload, "base64"));
  }

  private ensureTrackSession(track: string): ActiveTrackSession | null {
    if (!this.input.transcriber) {
      return null;
    }

    const existingSession = this.trackSessions.get(track);
    if (existingSession) {
      return existingSession;
    }

    const session = this.input.transcriber.createSession({
      callId: this.input.callId,
      track,
      encoding: this.mediaFormat.encoding,
      sampleRate: this.mediaFormat.sampleRate,
      onTranscript: async (result) => {
        await this.recordTranscript(track, result);
      },
      onError: async (error) => {
        console.error("Deepgram transcription error", {
          callId: this.input.callId,
          track,
          error,
        });
      },
    });

    const activeSession: ActiveTrackSession = {
      session,
      startPromise: session.start().catch((error: unknown) => {
        this.trackSessions.delete(track);
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        console.error("Failed to start Deepgram transcription", {
          callId: this.input.callId,
          track,
          error: normalizedError,
        });
        throw normalizedError;
      }),
    };
    this.trackSessions.set(track, activeSession);
    return activeSession;
  }

  private async recordTranscript(
    track: string,
    result: TranscriptionResult,
  ): Promise<void> {
    const text = result.text.trim();
    if (!text || this.closed || !result.isFinal) {
      return;
    }

    const segment: TranscriptSegment = {
      id: createTranscriptSegmentId(this.input.callId, track, result),
      callId: this.input.callId,
      speaker: createSpeakerName(track, result.providerSpeakerLabel),
      role: "unknown",
      providerSpeakerLabel: result.providerSpeakerLabel,
      text,
      isFinal: result.isFinal,
      startedAtMs: result.startedAtMs,
      endedAtMs: result.endedAtMs,
      confidence: result.confidence,
      createdAt: this.now(),
    };

    await this.input.callStore.upsertTranscriptSegment(segment);
    this.input.eventBus.publishTranscript(segment);

    void this.input.suggestionEngine
      ?.handleTranscriptSegment(segment)
      .catch((error: unknown) => {
        console.error("Failed to handle transcript segment for suggestions", {
          callId: this.input.callId,
          segmentId: segment.id,
          error,
        });
      });
  }
}

export function mapTelnyxEncodingToDeepgram(
  telnyxEncoding: unknown,
): TranscriptionAudioEncoding {
  const normalizedEncoding =
    typeof telnyxEncoding === "string" ? telnyxEncoding.toUpperCase() : "";

  switch (normalizedEncoding) {
    case "PCMU":
      return "mulaw";
    case "PCMA":
      return "alaw";
    case "L16":
      return "linear16";
    case "OPUS":
      return "opus";
    default:
      return defaultMediaFormat.encoding;
  }
}

function parseTelnyxStreamEvent(event: unknown): TelnyxStreamEvent | null {
  if (typeof event !== "object" || event === null || !("event" in event)) {
    return null;
  }

  const eventName = event.event;
  if (eventName === "start" || eventName === "media" || eventName === "stop") {
    return event as TelnyxStreamEvent;
  }

  return null;
}

function readMediaFormat(event: TelnyxStartEvent): MediaFormat {
  return {
    encoding: mapTelnyxEncodingToDeepgram(event.start?.media_format?.encoding),
    sampleRate:
      readNumber(event.start?.media_format?.sample_rate) ??
      defaultMediaFormat.sampleRate,
  };
}

function normalizeTrack(track: unknown): string {
  return sanitizeIdPart(readString(track) ?? "unknown");
}

function createSpeakerName(
  track: string,
  providerSpeakerLabel: string | undefined,
): string {
  return `telnyx_${track}_${sanitizeIdPart(providerSpeakerLabel ?? "speaker_unknown")}`;
}

function createTranscriptSegmentId(
  callId: string,
  track: string,
  result: TranscriptionResult,
): string {
  return [
    "transcript",
    sanitizeIdPart(callId),
    sanitizeIdPart(track),
    sanitizeIdPart(result.providerSpeakerLabel ?? "speaker_unknown"),
    Math.max(0, Math.round(result.startedAtMs)),
  ].join("_");
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  return null;
}
