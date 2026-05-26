import { describe, expect, it } from "vitest";

import type { Call, TranscriptSegment } from "../domain/types.js";
import { InMemoryCallEventBus } from "../events/call-event-bus.js";
import { InMemoryCallStore } from "../store/in-memory-call-store.js";
import type {
  ChatCompletionClient,
  ChatCompletionRequest,
} from "./chat-completions-client.js";
import {
  buildSuggestionPrompt,
  CallSuggestionEngine,
  parseSuggestionResponse,
} from "./suggestion-engine.js";

class FakeChatClient implements ChatCompletionClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async create(input: ChatCompletionRequest): Promise<string> {
    this.requests.push(input);
    return this.responses.shift() ?? '{"suggestions":[]}';
  }
}

describe("buildSuggestionPrompt", () => {
  it("includes call context, transcript, pending transcript, and prior suggestions", async () => {
    const call = createCall();
    const messages = buildSuggestionPrompt({
      call,
      transcript: [
        createSegment({
          id: "seg_1",
          callId: call.id,
          text: "I led the migration from the monolith to services.",
        }),
      ],
      pendingSegments: [
        createSegment({
          id: "seg_2",
          callId: call.id,
          startedAtMs: 2000,
          endedAtMs: 3000,
          text: "We reduced deploy time by half.",
        }),
      ],
      previousSuggestions: [
        {
          id: "sug_1",
          callId: call.id,
          text: "Ask about validation metrics.",
          sourceSegmentIds: ["seg_1"],
          createdAt: new Date("2026-05-20T00:00:00.000Z"),
        },
      ],
      summary: {
        callId: call.id,
        text: "Candidate described backend migration work.",
        updatedAt: new Date("2026-05-20T00:00:00.000Z"),
      },
      maxRecentSegments: 20,
      maxPreviousSuggestions: 10,
    });

    expect(messages[0]).toMatchObject({
      role: "system",
    });
    expect(messages[1].content).toContain("Candidate: Jane Candidate");
    expect(messages[1].content).toContain(
      "Candidate described backend migration work.",
    );
    expect(messages[1].content).toContain(
      "I led the migration from the monolith to services.",
    );
    expect(messages[1].content).toContain("We reduced deploy time by half.");
    expect(messages[1].content).toContain("Ask about validation metrics.");
  });
});

describe("parseSuggestionResponse", () => {
  it("parses structured suggestions", () => {
    expect(
      parseSuggestionResponse(
        JSON.stringify({
          suggestions: [
            {
              text: "Ask how they measured reliability.",
              reason: "They mentioned improvements without metrics.",
              priority: "medium",
              competency: "technical_depth",
            },
          ],
        }),
      ),
    ).toEqual([
      {
        text: "Ask how they measured reliability.",
        reason: "They mentioned improvements without metrics.",
        priority: "medium",
        competency: "technical_depth",
      },
    ]);
  });

  it("falls back to plain text suggestions for malformed JSON", () => {
    expect(
      parseSuggestionResponse(
        "- Ask what tradeoffs they considered.\n- Ask what they would do differently.",
      ),
    ).toEqual([
      {
        text: "Ask what tradeoffs they considered.",
        reason: "Model returned plain text instead of structured JSON.",
      },
      {
        text: "Ask what they would do differently.",
        reason: "Model returned plain text instead of structured JSON.",
      },
    ]);
  });
});

describe("CallSuggestionEngine", () => {
  it("stores and publishes suggestions for substantive final transcript", async () => {
    const callStore = new InMemoryCallStore({ createId: () => "call_123" });
    const eventBus = new InMemoryCallEventBus({
      createId: () => "event_123",
      now: () => new Date("2026-05-20T00:00:02.000Z"),
    });
    const chatClient = new FakeChatClient([
      JSON.stringify({
        suggestions: [
          {
            text: "Ask how they validated the migration improved reliability.",
            reason: "They described a migration without success metrics.",
            priority: "medium",
            competency: "technical_depth",
          },
        ],
      }),
    ]);
    const engine = new CallSuggestionEngine({
      callStore,
      eventBus,
      chatClient,
      createId: () => "sug_123",
      now: () => new Date("2026-05-20T00:00:01.000Z"),
      minIntervalMs: 15_000,
      minTranscriptChars: 120,
      firstSegmentMinChars: 20,
    });
    const call = await callStore.createCall({
      contextPrompt: "Candidate: Jane Candidate",
      dialInNumber: "+15122548727",
      conferenceName: "interview-int_789",
    });
    const segment = createSegment({
      callId: call.id,
      text: "I led a migration from a monolith to services and owned the rollout across the backend team.",
    });
    await callStore.upsertTranscriptSegment(segment);
    const subscription = eventBus.subscribe(call.id);
    const iterator = subscription[Symbol.asyncIterator]();

    await engine.handleTranscriptSegment(segment);
    const storedSuggestions = await callStore.listSuggestions(call.id);
    const event = await iterator.next();
    subscription.close();

    expect(chatClient.requests).toHaveLength(1);
    expect(storedSuggestions).toEqual([
      expect.objectContaining({
        id: "sug_123",
        text: "Ask how they validated the migration improved reliability.",
        reason: "They described a migration without success metrics.",
        priority: "medium",
        competency: "technical_depth",
        sourceSegmentIds: ["seg_1"],
      }),
    ]);
    expect(event.value).toMatchObject({
      id: "event_123",
      type: "suggestion",
      callId: call.id,
      data: {
        suggestionId: "sug_123",
        text: "Ask how they validated the migration improved reliability.",
      },
    });
  });

  it("does not call the model again inside the cadence interval", async () => {
    const callStore = new InMemoryCallStore({ createId: () => "call_123" });
    const eventBus = new InMemoryCallEventBus();
    const chatClient = new FakeChatClient([
      '{"suggestions":[]}',
      '{"suggestions":[{"text":"This should not be used."}]}',
    ]);
    const engine = new CallSuggestionEngine({
      callStore,
      eventBus,
      chatClient,
      now: () => new Date("2026-05-20T00:00:01.000Z"),
      minIntervalMs: 15_000,
      minTranscriptChars: 10,
      firstSegmentMinChars: 10,
    });
    const call = await callStore.createCall({
      contextPrompt: "Candidate: Jane Candidate",
      dialInNumber: "+15122548727",
      conferenceName: "interview-int_789",
    });
    const firstSegment = createSegment({
      id: "seg_1",
      callId: call.id,
      text: "I owned the service migration.",
    });
    const secondSegment = createSegment({
      id: "seg_2",
      callId: call.id,
      startedAtMs: 2000,
      endedAtMs: 3000,
      text: "It improved latency.",
    });

    await callStore.upsertTranscriptSegment(firstSegment);
    await engine.handleTranscriptSegment(firstSegment);
    await callStore.upsertTranscriptSegment(secondSegment);
    await engine.handleTranscriptSegment(secondSegment);

    expect(chatClient.requests).toHaveLength(1);
  });

  it("filters duplicate suggestions", async () => {
    const callStore = new InMemoryCallStore({ createId: () => "call_123" });
    const eventBus = new InMemoryCallEventBus();
    const chatClient = new FakeChatClient([
      JSON.stringify({
        suggestions: [
          {
            text: "Ask about validation metrics.",
          },
          {
            text: "Ask about validation metrics.",
          },
        ],
      }),
    ]);
    const engine = new CallSuggestionEngine({
      callStore,
      eventBus,
      chatClient,
      createId: () => "sug_123",
      now: () => new Date("2026-05-20T00:00:01.000Z"),
      firstSegmentMinChars: 10,
    });
    const call = await callStore.createCall({
      contextPrompt: "Candidate: Jane Candidate",
      dialInNumber: "+15122548727",
      conferenceName: "interview-int_789",
    });
    const segment = createSegment({
      callId: call.id,
      text: "I owned the migration and rollout.",
    });

    await callStore.upsertTranscriptSegment(segment);
    await engine.handleTranscriptSegment(segment);

    expect(await callStore.listSuggestions(call.id)).toHaveLength(1);
  });
});

function createCall(): Call {
  const now = new Date("2026-05-20T00:00:00.000Z");
  return {
    id: "call_123",
    provider: "telnyx",
    dialInNumber: "+15122548727",
    conferenceName: "interview-int_789",
    providerCallLegs: [],
    status: "active",
    contextPrompt: "Candidate: Jane Candidate\nRole: Backend Engineer",
    startedAt: now,
    lastActivityAt: now,
  };
}

function createSegment(
  patch: Partial<TranscriptSegment> &
    Pick<TranscriptSegment, "callId" | "text">,
): TranscriptSegment {
  return {
    id: patch.id ?? "seg_1",
    callId: patch.callId,
    speaker: patch.speaker ?? "telnyx_inbound_speaker_0",
    role: patch.role ?? "unknown",
    providerSpeakerLabel: patch.providerSpeakerLabel ?? "speaker_0",
    text: patch.text,
    isFinal: patch.isFinal ?? true,
    startedAtMs: patch.startedAtMs ?? 1000,
    endedAtMs: patch.endedAtMs ?? 2000,
    confidence: patch.confidence ?? 0.99,
    createdAt: patch.createdAt ?? new Date("2026-05-20T00:00:00.000Z"),
  };
}
