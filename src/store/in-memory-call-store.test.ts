import { describe, expect, it } from "vitest";

import { InMemoryCallStore } from "./in-memory-call-store.js";

describe("InMemoryCallStore", () => {
  it("creates and updates call lifecycle records", async () => {
    let now = new Date("2026-05-19T12:00:00.000Z");
    const store = new InMemoryCallStore({
      createId: () => "call_123",
      now: () => now,
    });

    const call = await store.createCall({
      contextPrompt: "Candidate: Jane Candidate",
      dialInNumber: "+15122548727",
      conferenceName: "interview-int_789",
    });

    now = new Date("2026-05-19T12:01:00.000Z");
    const updatedCall = await store.updateCall(call.id, {
      status: "active",
      providerCallId: "v3:test",
    });

    expect(call).toMatchObject({
      id: "call_123",
      status: "pending",
      provider: "telnyx",
    });
    expect(updatedCall).toMatchObject({
      id: "call_123",
      status: "active",
      providerCallId: "v3:test",
    });
    expect(updatedCall.lastActivityAt.toISOString()).toBe(
      "2026-05-19T12:01:00.000Z",
    );
  });

  it("appends transcript segments in timeline order", async () => {
    const store = new InMemoryCallStore({
      createId: () => "call_123",
      now: () => new Date("2026-05-19T12:00:00.000Z"),
    });
    const call = await store.createCall({
      contextPrompt: "Candidate: Jane Candidate",
      dialInNumber: "+15122548727",
      conferenceName: "interview-int_789",
    });

    await store.appendTranscriptSegment({
      id: "seg_2",
      callId: call.id,
      speaker: "speaker_1",
      role: "unknown",
      providerSpeakerLabel: "1",
      text: "Second segment",
      isFinal: true,
      startedAtMs: 2000,
      endedAtMs: 3000,
      confidence: 0.92,
      createdAt: new Date("2026-05-19T12:00:03.000Z"),
    });
    await store.appendTranscriptSegment({
      id: "seg_1",
      callId: call.id,
      speaker: "speaker_0",
      role: "unknown",
      providerSpeakerLabel: "0",
      text: "First segment",
      isFinal: true,
      startedAtMs: 0,
      endedAtMs: 1000,
      confidence: 0.94,
      createdAt: new Date("2026-05-19T12:00:01.000Z"),
    });

    const transcript = await store.listTranscriptSegments(call.id);

    expect(transcript.map((segment) => segment.id)).toEqual(["seg_1", "seg_2"]);
  });
});
