import { describe, expect, it } from "vitest";

import { InMemoryCallEventBus } from "../events/call-event-bus.js";
import { InMemoryCallStore } from "../store/in-memory-call-store.js";
import {
  mapTelnyxEncodingToDeepgram,
  TelnyxMediaTranscriptionSession,
} from "./telnyx-media-transcription.js";
import type {
  CreateTranscriptionSessionInput,
  StreamingTranscriber,
  TranscriptionResult,
  TranscriptionSession,
} from "./transcriber.js";

class FakeTranscriber implements StreamingTranscriber {
  readonly sessions: FakeTranscriptionSession[] = [];

  createSession(input: CreateTranscriptionSessionInput): TranscriptionSession {
    const session = new FakeTranscriptionSession(input);
    this.sessions.push(session);
    return session;
  }
}

class FakeTranscriptionSession implements TranscriptionSession {
  readonly audioFrames: Buffer[] = [];
  started = false;
  closed = false;

  constructor(readonly input: CreateTranscriptionSessionInput) {}

  async start(): Promise<void> {
    this.started = true;
  }

  sendAudio(audio: Buffer): void {
    this.audioFrames.push(audio);
  }

  close(): void {
    this.closed = true;
  }

  async emitTranscript(result: TranscriptionResult): Promise<void> {
    await this.input.onTranscript(result);
  }
}

describe("TelnyxMediaTranscriptionSession", () => {
  it("maps Telnyx PCMU media frames into Deepgram mulaw audio", async () => {
    const callStore = new InMemoryCallStore({ createId: () => "call_123" });
    const eventBus = new InMemoryCallEventBus();
    const transcriber = new FakeTranscriber();
    const call = await callStore.createCall({
      contextPrompt: "Candidate: Jane Candidate",
      dialInNumber: "+15122548727",
      conferenceName: "interview-int_789",
    });
    const session = new TelnyxMediaTranscriptionSession({
      callId: call.id,
      callStore,
      eventBus,
      transcriber,
      now: () => new Date("2026-05-19T12:00:00.000Z"),
    });

    await session.handleEvent({
      event: "start",
      start: {
        media_format: {
          encoding: "PCMU",
          sample_rate: 8000,
        },
      },
    });
    await session.handleEvent({
      event: "media",
      media: {
        track: "inbound",
        payload: Buffer.from([1, 2, 3]).toString("base64"),
      },
    });

    expect(transcriber.sessions).toHaveLength(1);
    expect(transcriber.sessions[0].input).toMatchObject({
      callId: "call_123",
      track: "inbound",
      encoding: "mulaw",
      sampleRate: 8000,
    });
    expect(transcriber.sessions[0].started).toBe(true);
    expect(transcriber.sessions[0].audioFrames).toEqual([
      Buffer.from([1, 2, 3]),
    ]);
  });

  it("records only final transcript segments and publishes call events", async () => {
    const callStore = new InMemoryCallStore({ createId: () => "call_123" });
    const eventBus = new InMemoryCallEventBus({
      createId: () => "event_123",
      now: () => new Date("2026-05-19T12:00:01.000Z"),
    });
    const transcriber = new FakeTranscriber();
    const call = await callStore.createCall({
      contextPrompt: "Candidate: Jane Candidate",
      dialInNumber: "+15122548727",
      conferenceName: "interview-int_789",
    });
    const subscription = eventBus.subscribe(call.id);
    const iterator = subscription[Symbol.asyncIterator]();
    const session = new TelnyxMediaTranscriptionSession({
      callId: call.id,
      callStore,
      eventBus,
      transcriber,
      now: () => new Date("2026-05-19T12:00:00.000Z"),
    });

    await session.handleEvent({
      event: "media",
      media: {
        track: "outbound",
        payload: Buffer.from([4, 5, 6]).toString("base64"),
      },
    });
    await transcriber.sessions[0].emitTranscript({
      text: "hello",
      isFinal: false,
      startedAtMs: 100,
      endedAtMs: 500,
      confidence: 0.8,
      providerSpeakerLabel: "speaker_0",
    });
    await expect(callStore.listTranscriptSegments(call.id)).resolves.toEqual(
      [],
    );
    await transcriber.sessions[0].emitTranscript({
      text: "hello there",
      isFinal: true,
      startedAtMs: 100,
      endedAtMs: 900,
      confidence: 0.94,
      providerSpeakerLabel: "speaker_0",
    });

    const transcript = await callStore.listTranscriptSegments(call.id);
    const event = await iterator.next();
    subscription.close();

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: "transcript_call_123_outbound_speaker_0_100",
      speaker: "telnyx_outbound_speaker_0",
      providerSpeakerLabel: "speaker_0",
      text: "hello there",
      isFinal: true,
      startedAtMs: 100,
      endedAtMs: 900,
      confidence: 0.94,
    });
    expect(event.value).toMatchObject({
      id: "event_123",
      type: "transcript",
      callId: call.id,
      data: {
        segmentId: "transcript_call_123_outbound_speaker_0_100",
        text: "hello there",
        isFinal: true,
      },
    });
  });

  it("closes track transcribers when Telnyx sends stop", async () => {
    const callStore = new InMemoryCallStore({ createId: () => "call_123" });
    const eventBus = new InMemoryCallEventBus();
    const transcriber = new FakeTranscriber();
    const call = await callStore.createCall({
      contextPrompt: "Candidate: Jane Candidate",
      dialInNumber: "+15122548727",
      conferenceName: "interview-int_789",
    });
    const session = new TelnyxMediaTranscriptionSession({
      callId: call.id,
      callStore,
      eventBus,
      transcriber,
    });

    await session.handleEvent({
      event: "media",
      media: {
        track: "inbound",
        payload: Buffer.from([1]).toString("base64"),
      },
    });
    await session.handleEvent({ event: "stop" });

    expect(transcriber.sessions[0].closed).toBe(true);
  });
});

describe("mapTelnyxEncodingToDeepgram", () => {
  it("maps known Telnyx codecs to Deepgram raw encodings", () => {
    expect(mapTelnyxEncodingToDeepgram("PCMU")).toBe("mulaw");
    expect(mapTelnyxEncodingToDeepgram("PCMA")).toBe("alaw");
    expect(mapTelnyxEncodingToDeepgram("L16")).toBe("linear16");
    expect(mapTelnyxEncodingToDeepgram("OPUS")).toBe("opus");
  });
});
