import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { InMemoryCallEventBus } from "./events/call-event-bus.js";
import type { TelnyxClient } from "./telnyx/client.js";

class FakeTelnyxClient implements TelnyxClient {
  readonly answers: Array<{ callControlId: string; commandId: string }> = [];
  readonly createdConferences: Array<{
    callControlId: string;
    conferenceName: string;
    commandId: string;
  }> = [];
  readonly joinedConferences: Array<{
    conferenceId: string;
    callControlId: string;
    commandId: string;
  }> = [];
  readonly streams: Array<{
    callControlId: string;
    streamUrl: string;
    commandId: string;
  }> = [];

  async answerCall(input: {
    callControlId: string;
    commandId: string;
  }): Promise<void> {
    this.answers.push(input);
  }

  async createConference(input: {
    callControlId: string;
    conferenceName: string;
    commandId: string;
  }): Promise<{ conferenceId: string | null }> {
    this.createdConferences.push(input);
    return { conferenceId: "conference_123" };
  }

  async joinConference(input: {
    conferenceId: string;
    callControlId: string;
    commandId: string;
  }): Promise<void> {
    this.joinedConferences.push(input);
  }

  async startStreaming(input: {
    callControlId: string;
    streamUrl: string;
    commandId: string;
  }): Promise<void> {
    this.streams.push(input);
  }
}

describe("app", () => {
  const testConfig = loadConfig({
    PORT: "3000",
    PUBLIC_BASE_URL: "https://example.test",
    TELNYX_DIAL_IN_NUMBER: "+15122548727",
  });

  it("returns health status", async () => {
    const app = createApp(testConfig);

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      service: "gkhr-interview-assistant",
    });
  });

  it("records Telnyx webhook pings", async () => {
    const app = createApp(testConfig);

    const webhookResponse = await app.request("/answerCall", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "telnyx-signature-ed25519": "test-signature",
      },
      body: JSON.stringify({
        data: {
          event_type: "call.initiated",
          id: "event_123",
        },
      }),
    });
    const webhookBody = await webhookResponse.json();

    const pingsResponse = await app.request("/webhook-pings");
    const pingsBody = await pingsResponse.json();

    expect(webhookResponse.status).toBe(200);
    expect(webhookBody).toMatchObject({
      ok: true,
      id: expect.any(String),
      receivedAt: expect.any(String),
    });
    expect(pingsBody.pings).toHaveLength(1);
    expect(pingsBody.pings[0]).toMatchObject({
      id: webhookBody.id,
      method: "POST",
      path: "/answerCall",
      body: {
        data: {
          event_type: "call.initiated",
          id: "event_123",
        },
      },
    });
  });

  it("creates and returns a pending call", async () => {
    const app = createApp(testConfig);

    const createResponse = await app.request("/calls", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contextPrompt:
          "Candidate: Jane Candidate\nRole: Senior Backend Engineer",
        conferenceName: "interview-int_789",
      }),
    });
    const createBody = await createResponse.json();

    const listResponse = await app.request("/calls");
    const listBody = await listResponse.json();

    expect(createResponse.status).toBe(201);
    expect(createBody.call).toMatchObject({
      id: expect.any(String),
      status: "pending",
      dialInNumber: "+15122548727",
      conferenceName: "interview-int_789",
      streamUrl: expect.stringMatching(/^\/calls\/.+\/stream$/),
      contextPreview: "Candidate: Jane Candidate Role: Senior Backend Engineer",
    });
    expect(listBody.calls).toHaveLength(1);
    expect(listBody.calls[0]).toMatchObject({
      id: createBody.call.id,
      status: "pending",
      dialInNumber: "+15122548727",
    });
  });

  it("returns call details", async () => {
    const app = createApp(testConfig);

    const createResponse = await app.request("/calls", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contextPrompt: "Candidate: Jane Candidate",
      }),
    });
    const createBody = await createResponse.json();

    const detailResponse = await app.request(`/calls/${createBody.call.id}`);
    const detailBody = await detailResponse.json();

    expect(detailResponse.status).toBe(200);
    expect(detailBody.call).toMatchObject({
      id: createBody.call.id,
      status: "pending",
      contextPrompt: "Candidate: Jane Candidate",
      transcript: [],
      suggestions: [],
      summary: null,
    });
  });

  it("rejects invalid call creation payloads", async () => {
    const app = createApp(testConfig);

    const response = await app.request("/calls", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
      },
    });
  });

  it("returns 404 for unknown calls", async () => {
    const app = createApp(testConfig);

    const response = await app.request("/calls/unknown-call");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "not_found",
      },
    });
  });

  it("streams published call events over SSE", async () => {
    const eventBus = new InMemoryCallEventBus({
      createId: () => "event_123",
      now: () => new Date("2026-05-19T12:00:00.000Z"),
    });
    const app = createApp(testConfig, { eventBus });

    const createResponse = await app.request("/calls", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contextPrompt: "Candidate: Jane Candidate",
      }),
    });
    const createBody = await createResponse.json();
    const streamResponse = await app.request(
      `/calls/${createBody.call.id}/stream`,
    );
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    eventBus.publishTranscript({
      id: "seg_123",
      callId: createBody.call.id,
      speaker: "speaker_0",
      role: "unknown",
      text: "Hello there",
      isFinal: true,
      startedAtMs: 0,
      endedAtMs: 1000,
      confidence: 0.95,
      createdAt: new Date("2026-05-19T12:00:00.000Z"),
    });

    const chunk = await reader?.read();
    await reader?.cancel();
    const frame = new TextDecoder().decode(chunk?.value);

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(frame).toContain("event: transcript");
    expect(frame).toContain("id: event_123");
    expect(frame).toContain('"segmentId":"seg_123"');
    expect(frame).toContain('"sequence":1');
  });

  it("returns 404 for unknown call streams", async () => {
    const app = createApp(testConfig);

    const response = await app.request("/calls/unknown-call/stream");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "not_found",
      },
    });
  });

  it("answers an inbound Telnyx call for a pending call", async () => {
    const telnyxClient = new FakeTelnyxClient();
    const app = createApp(testConfig, { telnyxClient });

    await app.request("/calls", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contextPrompt: "Candidate: Jane Candidate",
        conferenceName: "interview-int_789",
      }),
    });

    const webhookResponse = await app.request("/answerCall", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        data: {
          event_type: "call.initiated",
          id: "event_initiated_123",
          occurred_at: "2026-05-19T23:30:15.038431Z",
          payload: {
            call_control_id: "v3:test-call",
            call_leg_id: "leg_123",
            call_session_id: "session_123",
            connection_id: "connection_123",
            direction: "incoming",
            from: "+15129342627",
            state: "parked",
            to: "+15122548727",
          },
        },
      }),
    });
    const webhookBody = await webhookResponse.json();
    const callsResponse = await app.request("/calls");
    const callsBody = await callsResponse.json();

    expect(webhookResponse.status).toBe(200);
    expect(webhookBody.result).toMatchObject({
      action: "answer_sent",
      callControlId: "v3:test-call",
    });
    expect(telnyxClient.answers).toEqual([
      {
        callControlId: "v3:test-call",
        commandId: "answer:event_initiated_123",
      },
    ]);
    expect(callsBody.calls[0]).toMatchObject({
      providerCallId: "v3:test-call",
      status: "ringing",
    });
  });

  it("deduplicates Telnyx webhooks by event id", async () => {
    const telnyxClient = new FakeTelnyxClient();
    const app = createApp(testConfig, { telnyxClient });
    await app.request("/calls", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contextPrompt: "Candidate: Jane Candidate",
      }),
    });
    const webhook = {
      data: {
        event_type: "call.initiated",
        id: "event_duplicate_123",
        payload: {
          call_control_id: "v3:test-call",
          to: "+15122548727",
        },
      },
    };

    await app.request("/answerCall", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(webhook),
    });
    const duplicateResponse = await app.request("/answerCall", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(webhook),
    });
    const duplicateBody = await duplicateResponse.json();

    expect(telnyxClient.answers).toHaveLength(1);
    expect(duplicateBody).toMatchObject({
      ok: true,
      duplicate: true,
    });
  });

  it("creates a conference and starts streaming after call answered", async () => {
    const telnyxClient = new FakeTelnyxClient();
    const app = createApp(testConfig, { telnyxClient });

    const createResponse = await app.request("/calls", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contextPrompt: "Candidate: Jane Candidate",
        conferenceName: "interview-int_789",
      }),
    });
    const createBody = await createResponse.json();

    await app.request("/answerCall", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        data: {
          event_type: "call.initiated",
          id: "event_initiated_123",
          payload: {
            call_control_id: "v3:test-call",
            call_leg_id: "leg_123",
            call_session_id: "session_123",
            to: "+15122548727",
          },
        },
      }),
    });
    const answeredResponse = await app.request("/answerCall", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        data: {
          event_type: "call.answered",
          id: "event_answered_123",
          occurred_at: "2026-05-19T23:30:16.038431Z",
          payload: {
            call_control_id: "v3:test-call",
            call_leg_id: "leg_123",
            call_session_id: "session_123",
            to: "+15122548727",
          },
        },
      }),
    });
    const answeredBody = await answeredResponse.json();
    const detailResponse = await app.request(`/calls/${createBody.call.id}`);
    const detailBody = await detailResponse.json();

    expect(answeredResponse.status).toBe(200);
    expect(answeredBody.result).toMatchObject({
      action: "create_conference_sent",
      streamUrl: `wss://example.test/media/telnyx/${createBody.call.id}`,
    });
    expect(telnyxClient.createdConferences).toEqual([
      {
        callControlId: "v3:test-call",
        conferenceName: "interview-int_789",
        commandId: "create-conference:event_answered_123",
      },
    ]);
    expect(telnyxClient.streams).toEqual([
      {
        callControlId: "v3:test-call",
        streamUrl: `wss://example.test/media/telnyx/${createBody.call.id}`,
        commandId: "streaming-start:event_answered_123",
      },
    ]);
    expect(detailBody.call).toMatchObject({
      id: createBody.call.id,
      providerConferenceId: "conference_123",
      status: "active",
      providerCallLegs: [
        expect.objectContaining({
          callControlId: "v3:test-call",
          status: "answered",
        }),
      ],
    });
  });
});
