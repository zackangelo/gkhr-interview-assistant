import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { CallStore } from "../domain/call-store.js";
import type {
  Call,
  CallId,
  CallSummary,
  Suggestion,
  TranscriptSegment,
  TranscriptSegmentId,
} from "../domain/types.js";
import type { CallEventBus } from "../events/call-event-bus.js";
import type {
  ChatCompletionClient,
  ChatMessage,
} from "./chat-completions-client.js";

export interface SuggestionEngine {
  handleTranscriptSegment(segment: TranscriptSegment): Promise<void>;
}

interface CallSuggestionEngineOptions {
  callStore: CallStore;
  eventBus: CallEventBus;
  chatClient: ChatCompletionClient | null;
  createId?: () => string;
  now?: () => Date;
  minIntervalMs?: number;
  minTranscriptChars?: number;
  firstSegmentMinChars?: number;
  maxRecentSegments?: number;
  maxPreviousSuggestions?: number;
}

interface EngineState {
  inFlight: boolean;
  lastRequestedAtMs: number | null;
  lastGeneratedThroughMs: number;
}

interface PromptInput {
  call: Call;
  transcript: TranscriptSegment[];
  pendingSegments: TranscriptSegment[];
  previousSuggestions: Suggestion[];
  summary: CallSummary | null;
  maxRecentSegments: number;
  maxPreviousSuggestions: number;
}

interface ParsedSuggestion {
  text: string;
  reason?: string;
  priority?: "low" | "medium" | "high";
  competency?: string;
}

const suggestionResponseSchema = z.object({
  suggestions: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        reason: z.string().trim().min(1).optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        competency: z.string().trim().min(1).optional(),
      }),
    )
    .max(3),
});

export class CallSuggestionEngine implements SuggestionEngine {
  private readonly states = new Map<CallId, EngineState>();
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly minIntervalMs: number;
  private readonly minTranscriptChars: number;
  private readonly firstSegmentMinChars: number;
  private readonly maxRecentSegments: number;
  private readonly maxPreviousSuggestions: number;

  constructor(private readonly options: CallSuggestionEngineOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.minIntervalMs = options.minIntervalMs ?? 15_000;
    this.minTranscriptChars = options.minTranscriptChars ?? 120;
    this.firstSegmentMinChars = options.firstSegmentMinChars ?? 40;
    this.maxRecentSegments = options.maxRecentSegments ?? 30;
    this.maxPreviousSuggestions = options.maxPreviousSuggestions ?? 12;
  }

  async handleTranscriptSegment(segment: TranscriptSegment): Promise<void> {
    if (!this.options.chatClient || !segment.isFinal) {
      return;
    }

    const state = this.getState(segment.callId);
    if (state.inFlight) {
      return;
    }

    const call = await this.options.callStore.getCall(segment.callId);
    if (!call || call.status === "completed" || call.status === "failed") {
      return;
    }

    const transcript = await this.options.callStore.listTranscriptSegments(
      segment.callId,
    );
    const finalTranscript = transcript.filter((item) => item.isFinal);
    const pendingSegments = finalTranscript.filter(
      (item) => item.endedAtMs > state.lastGeneratedThroughMs,
    );
    if (!this.shouldGenerate(state, pendingSegments)) {
      return;
    }

    state.inFlight = true;
    state.lastRequestedAtMs = this.now().getTime();
    try {
      await this.generateForCall(call, finalTranscript, pendingSegments);
      state.lastGeneratedThroughMs = Math.max(
        state.lastGeneratedThroughMs,
        ...pendingSegments.map((item) => item.endedAtMs),
      );
    } catch (error) {
      console.error("Failed to generate interviewer suggestions", {
        callId: segment.callId,
        error,
      });
    } finally {
      state.inFlight = false;
    }
  }

  private async generateForCall(
    call: Call,
    transcript: TranscriptSegment[],
    pendingSegments: TranscriptSegment[],
  ): Promise<void> {
    const [previousSuggestions, summary] = await Promise.all([
      this.options.callStore.listSuggestions(call.id),
      this.options.callStore.getSummary(call.id),
    ]);
    const messages = buildSuggestionPrompt({
      call,
      transcript,
      pendingSegments,
      previousSuggestions,
      summary,
      maxRecentSegments: this.maxRecentSegments,
      maxPreviousSuggestions: this.maxPreviousSuggestions,
    });
    const response = await this.options.chatClient?.create({
      messages,
      responseFormat: suggestionResponseFormat,
      temperature: 0.2,
      maxCompletionTokens: 700,
    });
    if (!response) {
      return;
    }

    const sourceSegmentIds = pendingSegments.map((item) => item.id);
    const parsedSuggestions = parseSuggestionResponse(response);
    await this.storeSuggestions({
      callId: call.id,
      parsedSuggestions,
      previousSuggestions,
      sourceSegmentIds,
    });
  }

  private async storeSuggestions(input: {
    callId: CallId;
    parsedSuggestions: ParsedSuggestion[];
    previousSuggestions: Suggestion[];
    sourceSegmentIds: TranscriptSegmentId[];
  }): Promise<void> {
    const existingTexts = new Set(
      input.previousSuggestions.map((suggestion) =>
        normalizeSuggestionText(suggestion.text),
      ),
    );

    for (const parsedSuggestion of input.parsedSuggestions) {
      const normalizedText = normalizeSuggestionText(parsedSuggestion.text);
      if (existingTexts.has(normalizedText)) {
        continue;
      }
      existingTexts.add(normalizedText);

      const suggestion: Suggestion = {
        id: this.createId(),
        callId: input.callId,
        text: parsedSuggestion.text,
        reason: parsedSuggestion.reason,
        priority: parsedSuggestion.priority,
        competency: parsedSuggestion.competency,
        sourceSegmentIds: input.sourceSegmentIds,
        createdAt: this.now(),
      };

      await this.options.callStore.appendSuggestion(suggestion);
      this.options.eventBus.publishSuggestion(suggestion);
    }
  }

  private shouldGenerate(
    state: EngineState,
    pendingSegments: TranscriptSegment[],
  ): boolean {
    if (pendingSegments.length === 0) {
      return false;
    }

    const nowMs = this.now().getTime();
    if (
      state.lastRequestedAtMs !== null &&
      nowMs - state.lastRequestedAtMs < this.minIntervalMs
    ) {
      return false;
    }

    const pendingText = pendingSegments.map((item) => item.text).join(" ");
    if (
      state.lastRequestedAtMs === null &&
      pendingText.length >= this.firstSegmentMinChars
    ) {
      return true;
    }

    return pendingText.length >= this.minTranscriptChars;
  }

  private getState(callId: CallId): EngineState {
    const existingState = this.states.get(callId);
    if (existingState) {
      return existingState;
    }

    const state: EngineState = {
      inFlight: false,
      lastRequestedAtMs: null,
      lastGeneratedThroughMs: 0,
    };
    this.states.set(callId, state);
    return state;
  }
}

export function buildSuggestionPrompt(input: PromptInput): ChatMessage[] {
  const recentTranscript = input.transcript
    .slice(-input.maxRecentSegments)
    .map(formatTranscriptSegment)
    .join("\n");
  const pendingTranscript = input.pendingSegments
    .map(formatTranscriptSegment)
    .join("\n");
  const previousSuggestions = input.previousSuggestions
    .slice(-input.maxPreviousSuggestions)
    .map((suggestion) => `- ${suggestion.text}`)
    .join("\n");

  return [
    {
      role: "system",
      content: [
        "You are a real-time interview coach assisting the interviewer.",
        "Suggest concise, useful follow-up questions or probes for the interviewer to ask next.",
        "Do not write feedback to the candidate. Do not repeat prior suggestions.",
        "Return JSON only, with at most three suggestions.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        "Call context:",
        input.call.contextPrompt,
        "",
        "Running summary:",
        input.summary?.text ?? "No summary is available yet.",
        "",
        "Recent diarized transcript:",
        recentTranscript || "No final transcript is available yet.",
        "",
        "New final transcript since the previous suggestion request:",
        pendingTranscript,
        "",
        "Previous suggestions:",
        previousSuggestions || "No previous suggestions.",
        "",
        "Return a JSON object shaped exactly like:",
        '{"suggestions":[{"text":"Ask a specific follow-up question.","reason":"Why this is useful now.","priority":"low|medium|high","competency":"optional_competency_name"}]}',
        "Use an empty suggestions array if there is no useful interviewer question to suggest yet.",
      ].join("\n"),
    },
  ];
}

export function parseSuggestionResponse(content: string): ParsedSuggestion[] {
  const parsedJson = parseJsonObject(content);
  const schemaResult = parsedJson
    ? suggestionResponseSchema.safeParse(parsedJson)
    : null;
  if (schemaResult?.success) {
    return schemaResult.data.suggestions;
  }

  return parsePlainTextSuggestions(content);
}

const suggestionResponseFormat = {
  type: "json_schema",
  json_schema: {
    schema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              reason: { type: "string" },
              priority: { type: "string", enum: ["low", "medium", "high"] },
              competency: { type: "string" },
            },
            required: ["text"],
          },
        },
      },
      required: ["suggestions"],
    },
    strict: true,
  },
};

function parseJsonObject(content: string): unknown | null {
  const trimmedContent = content.trim();
  const directParse = tryParseJson(trimmedContent);
  if (directParse) {
    return directParse;
  }

  const fencedMatch = trimmedContent.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    const fencedParse = tryParseJson(fencedMatch[1].trim());
    if (fencedParse) {
      return fencedParse;
    }
  }

  const startIndex = trimmedContent.indexOf("{");
  const endIndex = trimmedContent.lastIndexOf("}");
  if (startIndex >= 0 && endIndex > startIndex) {
    return tryParseJson(trimmedContent.slice(startIndex, endIndex + 1));
  }

  return null;
}

function tryParseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function parsePlainTextSuggestions(content: string): ParsedSuggestion[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .map((line) => ({
      text: line,
      reason: "Model returned plain text instead of structured JSON.",
    }));
}

function formatTranscriptSegment(segment: TranscriptSegment): string {
  return `[${formatTime(segment.startedAtMs)}-${formatTime(segment.endedAtMs)}] ${segment.speaker}: ${segment.text}`;
}

function formatTime(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function normalizeSuggestionText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
