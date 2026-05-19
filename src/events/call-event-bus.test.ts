import { describe, expect, it } from "vitest";

import { InMemoryCallEventBus } from "./call-event-bus.js";

describe("InMemoryCallEventBus", () => {
  it("publishes transcript and suggestion events in sequence", async () => {
    let idIndex = 0;
    const eventBus = new InMemoryCallEventBus({
      createId: () => `event_${++idIndex}`,
      now: () => new Date("2026-05-19T12:00:00.000Z"),
    });
    const subscription = eventBus.subscribe("call_123");
    const iterator = subscription[Symbol.asyncIterator]();

    eventBus.publishTranscript({
      id: "seg_123",
      callId: "call_123",
      speaker: "speaker_0",
      role: "unknown",
      providerSpeakerLabel: "0",
      text: "Tell me about the migration.",
      isFinal: true,
      startedAtMs: 0,
      endedAtMs: 1200,
      confidence: 0.94,
      createdAt: new Date("2026-05-19T12:00:01.000Z"),
    });
    eventBus.publishSuggestion({
      id: "sug_123",
      callId: "call_123",
      text: "Ask what tradeoffs they considered.",
      reason: "They described the outcome but not alternatives.",
      priority: "medium",
      competency: "technical_depth",
      sourceSegmentIds: ["seg_123"],
      createdAt: new Date("2026-05-19T12:00:02.000Z"),
    });

    const first = await iterator.next();
    const second = await iterator.next();
    subscription.close();

    expect(first.value).toMatchObject({
      id: "event_1",
      type: "transcript",
      callId: "call_123",
      sequence: 1,
      data: {
        segmentId: "seg_123",
      },
    });
    expect(second.value).toMatchObject({
      id: "event_2",
      type: "suggestion",
      callId: "call_123",
      sequence: 2,
      data: {
        suggestionId: "sug_123",
      },
    });
  });
});
