import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import type { CallStore } from "./domain/call-store.js";
import type { Call, Suggestion, TranscriptSegment } from "./domain/types.js";
import type { CallEventBus } from "./events/call-event-bus.js";
import { InMemoryCallEventBus } from "./events/call-event-bus.js";
import { InMemoryCallStore } from "./store/in-memory-call-store.js";

interface WebhookPing {
  id: string;
  receivedAt: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  body: unknown;
}

const maxWebhookPings = 20;

interface AppDependencies {
  callStore?: CallStore;
  eventBus?: CallEventBus;
}

const createCallSchema = z.object({
  contextPrompt: z.string().trim().min(1),
  conferenceName: z.string().trim().min(1).optional(),
});

export function createApp(
  config: AppConfig,
  dependencies: AppDependencies = {},
): Hono {
  const app = new Hono();
  const callStore = dependencies.callStore ?? new InMemoryCallStore();
  const eventBus = dependencies.eventBus ?? new InMemoryCallEventBus();
  const webhookPings: WebhookPing[] = [];

  app.get("/", (c) => {
    return c.json({
      name: "gkhr-interview-assistant",
      status: "ok",
    });
  });

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      service: "gkhr-interview-assistant",
      port: config.port,
    });
  });

  app.post("/calls", async (c) => {
    if (!config.telnyxDialInNumber) {
      return c.json(
        {
          error: {
            code: "missing_config",
            message: "TELNYX_DIAL_IN_NUMBER is required to create calls.",
          },
        },
        500,
      );
    }

    const body = await c.req.json().catch(() => null);
    const result = createCallSchema.safeParse(body);
    if (!result.success) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Request body must include contextPrompt.",
            issues: result.error.issues,
          },
        },
        400,
      );
    }

    const call = await callStore.createCall({
      contextPrompt: result.data.contextPrompt,
      dialInNumber: config.telnyxDialInNumber,
      conferenceName: result.data.conferenceName ?? `interview-${randomUUID()}`,
    });

    return c.json(
      {
        call: serializeCallSummary(call),
      },
      201,
    );
  });

  app.get("/calls", async (c) => {
    const calls = await callStore.listCalls();

    return c.json({
      calls: calls
        .filter(
          (call) => call.status !== "completed" && call.status !== "failed",
        )
        .map(serializeCallSummary),
    });
  });

  app.get("/calls/:call_id", async (c) => {
    const callId = c.req.param("call_id");
    const call = await callStore.getCall(callId);
    if (!call) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: `Call not found: ${callId}`,
          },
        },
        404,
      );
    }

    const [transcript, suggestions, summary] = await Promise.all([
      callStore.listTranscriptSegments(callId),
      callStore.listSuggestions(callId),
      callStore.getSummary(callId),
    ]);

    return c.json({
      call: {
        ...serializeCall(call),
        transcript: transcript.map(serializeTranscriptSegment),
        suggestions: suggestions.map(serializeSuggestion),
        summary: summary
          ? {
              text: summary.text,
              updatedAt: summary.updatedAt.toISOString(),
            }
          : null,
      },
    });
  });

  app.get("/calls/:call_id/stream", async (c) => {
    const callId = c.req.param("call_id");
    const call = await callStore.getCall(callId);
    if (!call) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: `Call not found: ${callId}`,
          },
        },
        404,
      );
    }

    const subscription = eventBus.subscribe(callId);

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        subscription.close();
      });

      for await (const event of subscription) {
        if (stream.aborted) {
          break;
        }

        await stream.writeSSE({
          event: event.type,
          id: event.id,
          data: JSON.stringify(event),
        });
      }
    });
  });

  app.post("/answerCall", async (c) => {
    const rawBody = await c.req.text();
    const ping: WebhookPing = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      method: c.req.method,
      path: c.req.path,
      headers: redactHeaders(c.req.raw.headers),
      rawBody,
      body: parseJson(rawBody),
    };

    webhookPings.unshift(ping);
    webhookPings.splice(maxWebhookPings);

    return c.json({
      ok: true,
      id: ping.id,
      receivedAt: ping.receivedAt,
    });
  });

  app.get("/webhook-pings", (c) => {
    return c.json({
      pings: webhookPings,
    });
  });

  return app;
}

function serializeCallSummary(call: Call) {
  return {
    id: call.id,
    provider: call.provider,
    providerCallId: call.providerCallId ?? null,
    status: call.status,
    dialInNumber: call.dialInNumber,
    conferenceName: call.conferenceName,
    streamUrl: `/calls/${call.id}/stream`,
    startedAt: call.startedAt.toISOString(),
    contextPreview: createContextPreview(call.contextPrompt),
    lastActivityAt: call.lastActivityAt.toISOString(),
  };
}

function serializeCall(call: Call) {
  return {
    ...serializeCallSummary(call),
    providerCallLegId: call.providerCallLegId ?? null,
    providerCallSessionId: call.providerCallSessionId ?? null,
    providerConferenceId: call.providerConferenceId ?? null,
    providerSessionId: call.providerSessionId ?? null,
    contextPrompt: call.contextPrompt,
    endedAt: call.endedAt ? call.endedAt.toISOString() : null,
  };
}

function serializeTranscriptSegment(segment: TranscriptSegment) {
  return {
    id: segment.id,
    callId: segment.callId,
    speaker: segment.speaker,
    role: segment.role,
    providerSpeakerLabel: segment.providerSpeakerLabel ?? null,
    text: segment.text,
    isFinal: segment.isFinal,
    startedAtMs: segment.startedAtMs,
    endedAtMs: segment.endedAtMs,
    confidence: segment.confidence ?? null,
    createdAt: segment.createdAt.toISOString(),
  };
}

function serializeSuggestion(suggestion: Suggestion) {
  return {
    id: suggestion.id,
    callId: suggestion.callId,
    text: suggestion.text,
    reason: suggestion.reason ?? null,
    priority: suggestion.priority ?? null,
    competency: suggestion.competency ?? null,
    sourceSegmentIds: suggestion.sourceSegmentIds,
    createdAt: suggestion.createdAt.toISOString(),
  };
}

function createContextPreview(contextPrompt: string): string {
  const normalizedPrompt = contextPrompt.replace(/\s+/g, " ").trim();
  return normalizedPrompt.length > 120
    ? `${normalizedPrompt.slice(0, 117)}...`
    : normalizedPrompt;
}

function parseJson(rawBody: string): unknown {
  if (rawBody.length === 0) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function redactHeaders(headers: Headers): Record<string, string> {
  const retainedHeaders = new Set([
    "content-length",
    "content-type",
    "host",
    "telnyx-signature-ed25519",
    "telnyx-timestamp",
    "user-agent",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]);

  return Object.fromEntries(
    [...headers.entries()]
      .filter(([name]) => retainedHeaders.has(name.toLowerCase()))
      .map(([name, value]) => [name, value]),
  );
}
