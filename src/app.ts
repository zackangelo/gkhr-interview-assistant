import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { UpgradeWebSocket } from "hono/ws";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import type { CallStore } from "./domain/call-store.js";
import type {
  Call,
  ProviderCallLeg,
  ProviderCallLegStatus,
  Suggestion,
  TranscriptSegment,
} from "./domain/types.js";
import type { CallEventBus } from "./events/call-event-bus.js";
import { InMemoryCallEventBus } from "./events/call-event-bus.js";
import type { SuggestionEngine } from "./suggestions/suggestion-engine.js";
import { InMemoryCallStore } from "./store/in-memory-call-store.js";
import type { TelnyxClient } from "./telnyx/client.js";
import { HttpTelnyxClient } from "./telnyx/client.js";
import type { MediaStreamStore } from "./telnyx/media-stream-store.js";
import { InMemoryMediaStreamStore } from "./telnyx/media-stream-store.js";
import {
  parseTelnyxWebhookEvent,
  verifyTelnyxWebhookSignature,
  type TelnyxWebhookEvent,
} from "./telnyx/webhooks.js";
import { TelnyxMediaTranscriptionSession } from "./transcription/telnyx-media-transcription.js";
import type { StreamingTranscriber } from "./transcription/transcriber.js";

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
  mediaStreamStore?: MediaStreamStore;
  telnyxClient?: TelnyxClient;
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
  const mediaStreamStore =
    dependencies.mediaStreamStore ?? new InMemoryMediaStreamStore();
  const telnyxClient =
    dependencies.telnyxClient ??
    (config.telnyxApiKey ? new HttpTelnyxClient(config.telnyxApiKey) : null);
  const webhookPings: WebhookPing[] = [];
  const processedWebhookIds = new Set<string>();

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

    if (config.telnyxWebhookPublicKey) {
      const signatureValid = verifyTelnyxWebhookSignature({
        rawBody,
        publicKey: config.telnyxWebhookPublicKey,
        signature: c.req.header("telnyx-signature-ed25519") ?? null,
        timestamp: c.req.header("telnyx-timestamp") ?? null,
      });

      if (!signatureValid) {
        return c.json(
          {
            error: {
              code: "invalid_signature",
              message: "Invalid Telnyx webhook signature.",
            },
          },
          401,
        );
      }
    }

    const event = parseTelnyxWebhookEvent(ping.body);
    if (!event) {
      return c.json(
        {
          error: {
            code: "invalid_webhook",
            message: "Invalid Telnyx webhook payload.",
          },
        },
        400,
      );
    }

    if (processedWebhookIds.has(event.data.id)) {
      return c.json({
        ok: true,
        duplicate: true,
        id: ping.id,
        receivedAt: ping.receivedAt,
      });
    }

    try {
      const result = await handleTelnyxWebhookEvent({
        callStore,
        config,
        event,
        telnyxClient,
      });
      processedWebhookIds.add(event.data.id);

      return c.json({
        ok: true,
        id: ping.id,
        receivedAt: ping.receivedAt,
        result,
      });
    } catch (error) {
      console.error("Failed to handle Telnyx webhook", error);
      return c.json(
        {
          error: {
            code: "telnyx_webhook_failed",
            message: "Failed to process Telnyx webhook.",
          },
        },
        500,
      );
    }
  });

  app.get("/media/telnyx/:call_id/events", async (c) => {
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

    return c.json({
      events: (await mediaStreamStore.listEvents(callId)).map((event) => ({
        ...event,
        receivedAt: event.receivedAt.toISOString(),
      })),
    });
  });

  app.get("/webhook-pings", (c) => {
    return c.json({
      pings: webhookPings,
    });
  });

  return app;
}

export function registerMediaWebSocketRoute(
  app: Hono,
  input: {
    upgradeWebSocket: UpgradeWebSocket;
    mediaStreamStore: MediaStreamStore;
    callStore?: CallStore;
    eventBus?: CallEventBus;
    transcriber?: StreamingTranscriber | null;
    suggestionEngine?: SuggestionEngine | null;
  },
): void {
  app.get(
    "/media/telnyx/:call_id",
    input.upgradeWebSocket((c) => {
      const callId = c.req.param("call_id") ?? "unknown";
      let transcriptionSession: TelnyxMediaTranscriptionSession | null = null;

      return {
        onOpen: async () => {
          if (input.callStore && input.eventBus) {
            transcriptionSession = new TelnyxMediaTranscriptionSession({
              callId,
              callStore: input.callStore,
              eventBus: input.eventBus,
              transcriber: input.transcriber ?? null,
              suggestionEngine: input.suggestionEngine ?? null,
            });
          }

          await input.mediaStreamStore.recordEvent({
            id: randomUUID(),
            callId,
            receivedAt: new Date(),
            event: { event: "socket.open" },
          });
        },
        onMessage: async (message) => {
          const event = parseJson(String(message.data)) ?? message.data;
          await input.mediaStreamStore.recordEvent({
            id: randomUUID(),
            callId,
            receivedAt: new Date(),
            event,
          });

          await transcriptionSession
            ?.handleEvent(event)
            .catch((error: unknown) => {
              console.error("Failed to handle Telnyx media event", {
                callId,
                error,
              });
            });
        },
        onClose: async (event) => {
          await input.mediaStreamStore.recordEvent({
            id: randomUUID(),
            callId,
            receivedAt: new Date(),
            event: {
              event: "socket.close",
              code: event.code,
              reason: event.reason,
            },
          });
          await transcriptionSession?.close();
        },
        onError: async (event) => {
          await input.mediaStreamStore.recordEvent({
            id: randomUUID(),
            callId,
            receivedAt: new Date(),
            event: {
              event: "socket.error",
              message: getWebSocketErrorMessage(event),
            },
          });
          await transcriptionSession?.close();
        },
      };
    }),
  );
}

async function handleTelnyxWebhookEvent(input: {
  callStore: CallStore;
  config: AppConfig;
  event: TelnyxWebhookEvent;
  telnyxClient: TelnyxClient | null;
}) {
  const eventType = input.event.data.event_type;
  const payload = input.event.data.payload;

  if (eventType === "call.initiated") {
    const callControlId = readString(payload.call_control_id);
    const to = readString(payload.to);
    if (!callControlId || !to) {
      return { action: "ignored", reason: "missing_call_control_or_to" };
    }

    const call = await resolveCallForIncomingWebhook(input.callStore, to);
    if (!call) {
      return { action: "ignored", reason: "no_matching_call" };
    }

    const updatedCall = await input.callStore.updateCall(call.id, {
      providerCallId: call.providerCallId ?? callControlId,
      providerCallLegId:
        call.providerCallLegId ?? readString(payload.call_leg_id) ?? undefined,
      providerCallSessionId:
        call.providerCallSessionId ??
        readString(payload.call_session_id) ??
        undefined,
      providerCallLegs: upsertCallLeg(call, payload, "initiated"),
      status: "ringing",
    });

    await requireTelnyxClient(input.telnyxClient).answerCall({
      callControlId,
      commandId: `answer:${input.event.data.id}`,
    });

    return {
      action: "answer_sent",
      callId: updatedCall.id,
      callControlId,
    };
  }

  if (eventType === "call.answered") {
    const callControlId = readString(payload.call_control_id);
    if (!callControlId) {
      return { action: "ignored", reason: "missing_call_control" };
    }

    const call = await findCallByCallControlId(input.callStore, callControlId);
    if (!call) {
      return { action: "ignored", reason: "no_matching_call" };
    }

    const activeCall = await input.callStore.updateCall(call.id, {
      providerCallLegs: upsertCallLeg(call, payload, "answered", {
        answeredAt: new Date(input.event.data.occurred_at ?? Date.now()),
      }),
      status: "active",
    });
    const telnyxClient = requireTelnyxClient(input.telnyxClient);

    if (activeCall.providerConferenceId) {
      await telnyxClient.joinConference({
        conferenceId: activeCall.providerConferenceId,
        callControlId,
        commandId: `join-conference:${input.event.data.id}`,
      });
    } else {
      const conference = await telnyxClient.createConference({
        callControlId,
        conferenceName: activeCall.conferenceName,
        commandId: `create-conference:${input.event.data.id}`,
      });

      if (conference.conferenceId) {
        await input.callStore.updateCall(activeCall.id, {
          providerConferenceId: conference.conferenceId,
        });
      }
    }

    const streamUrl = buildTelnyxMediaStreamUrl(input.config, activeCall.id);
    if (streamUrl) {
      await telnyxClient.startStreaming({
        callControlId,
        streamUrl,
        commandId: `streaming-start:${input.event.data.id}`,
      });
    }

    return {
      action: activeCall.providerConferenceId
        ? "join_conference_sent"
        : "create_conference_sent",
      callId: activeCall.id,
      callControlId,
      streamUrl,
    };
  }

  if (
    eventType === "conference.created" ||
    eventType === "conference.participant.joined"
  ) {
    const callControlId = readString(payload.call_control_id);
    const conferenceId = readString(payload.conference_id);
    if (!callControlId || !conferenceId) {
      return { action: "ignored", reason: "missing_conference_fields" };
    }

    const call = await findCallByCallControlId(input.callStore, callControlId);
    if (!call) {
      return { action: "ignored", reason: "no_matching_call" };
    }

    await input.callStore.updateCall(call.id, {
      providerConferenceId: conferenceId,
      providerCallLegs: upsertCallLeg(call, payload, "joined"),
      status: "active",
    });

    return {
      action: "conference_recorded",
      callId: call.id,
      conferenceId,
    };
  }

  if (eventType === "call.hangup") {
    const callControlId = readString(payload.call_control_id);
    if (!callControlId) {
      return { action: "ignored", reason: "missing_call_control" };
    }

    const call = await findCallByCallControlId(input.callStore, callControlId);
    if (!call) {
      return { action: "ignored", reason: "no_matching_call" };
    }

    await input.callStore.updateCall(call.id, {
      providerCallLegs: upsertCallLeg(call, payload, "completed", {
        endedAt: new Date(input.event.data.occurred_at ?? Date.now()),
      }),
      status: "completed",
      endedAt: new Date(input.event.data.occurred_at ?? Date.now()),
    });

    return {
      action: "call_completed",
      callId: call.id,
    };
  }

  return {
    action: "ignored",
    reason: `unsupported_event:${eventType}`,
  };
}

async function resolveCallForIncomingWebhook(
  callStore: CallStore,
  dialInNumber: string,
): Promise<Call | null> {
  const calls = await callStore.listCalls();
  const matchingCalls = calls.filter(
    (call) =>
      call.dialInNumber === dialInNumber &&
      call.status !== "completed" &&
      call.status !== "failed",
  );

  return (
    matchingCalls.find((call) => call.status === "pending") ??
    matchingCalls[0] ??
    null
  );
}

async function findCallByCallControlId(
  callStore: CallStore,
  callControlId: string,
): Promise<Call | null> {
  const calls = await callStore.listCalls();
  return (
    calls.find(
      (call) =>
        call.providerCallId === callControlId ||
        call.providerCallLegs.some(
          (leg) => leg.callControlId === callControlId,
        ),
    ) ?? null
  );
}

function upsertCallLeg(
  call: Call,
  payload: Record<string, unknown>,
  status: ProviderCallLegStatus,
  timestamps: Pick<Partial<ProviderCallLeg>, "answeredAt" | "endedAt"> = {},
): ProviderCallLeg[] {
  const callControlId = readString(payload.call_control_id);
  if (!callControlId) {
    return call.providerCallLegs;
  }

  const existingLeg = call.providerCallLegs.find(
    (leg) => leg.callControlId === callControlId,
  );
  const nextLeg: ProviderCallLeg = {
    callControlId,
    callLegId: readString(payload.call_leg_id) ?? existingLeg?.callLegId,
    callSessionId:
      readString(payload.call_session_id) ?? existingLeg?.callSessionId,
    connectionId:
      readString(payload.connection_id) ?? existingLeg?.connectionId,
    from: readString(payload.from) ?? existingLeg?.from,
    to: readString(payload.to) ?? existingLeg?.to,
    direction: readString(payload.direction) ?? existingLeg?.direction,
    status,
    createdAt: existingLeg?.createdAt ?? new Date(),
    answeredAt: timestamps.answeredAt ?? existingLeg?.answeredAt,
    endedAt: timestamps.endedAt ?? existingLeg?.endedAt,
  };

  return [
    ...call.providerCallLegs.filter(
      (leg) => leg.callControlId !== callControlId,
    ),
    nextLeg,
  ];
}

function requireTelnyxClient(telnyxClient: TelnyxClient | null): TelnyxClient {
  if (!telnyxClient) {
    throw new Error("TELNYX_API_KEY is required to control Telnyx calls.");
  }

  return telnyxClient;
}

function buildTelnyxMediaStreamUrl(
  config: AppConfig,
  callId: string,
): string | null {
  if (!config.publicBaseUrl) {
    return null;
  }

  const streamUrl = new URL(`/media/telnyx/${callId}`, config.publicBaseUrl);
  streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
  return streamUrl.toString();
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
    providerCallLegs: call.providerCallLegs.map((leg) => ({
      ...leg,
      createdAt: leg.createdAt.toISOString(),
      answeredAt: leg.answeredAt ? leg.answeredAt.toISOString() : null,
      endedAt: leg.endedAt ? leg.endedAt.toISOString() : null,
    })),
    contextPrompt: call.contextPrompt,
    endedAt: call.endedAt ? call.endedAt.toISOString() : null,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

function getWebSocketErrorMessage(event: unknown): string {
  if (event instanceof Error) {
    return event.message;
  }

  if (
    typeof ErrorEvent !== "undefined" &&
    event instanceof ErrorEvent &&
    event.message
  ) {
    return String(event.message);
  }

  return "WebSocket error";
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
