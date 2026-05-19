import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

describe("app", () => {
  const testConfig = loadConfig({
    PORT: "3000",
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
});
