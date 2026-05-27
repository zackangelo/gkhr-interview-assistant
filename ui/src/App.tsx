import { FormEvent, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

import { createCall, fetchCall, fetchCalls } from "./api";
import type {
  CallDetail,
  CallSummary,
  CallUpdateData,
  StreamEvent,
  Suggestion,
  TimelineItem,
  TimelineTranscriptItem,
  TranscriptSegment,
} from "./types";

interface ConnectionState {
  status: "connected" | "pending" | "error";
  label: string;
}

const defaultContextPrompt = `# Interview Context

## Candidate

**Name:** Maya Chen
**Current role:** Senior Backend Engineer at Northstar Labs
**Experience:** 8 years building distributed systems, payments platforms, and internal developer tooling.

### Background Highlights

- Led a 14-month migration from a Ruby monolith to event-driven Node.js and Go services.
- Designed a fraud-review workflow that reduced manual review time by 38%.
- Mentored five engineers through a backend guild and ran architecture review sessions.
- Has worked with PostgreSQL, Kafka, Redis, Kubernetes, TypeScript, Go, and observability tooling.

### Potential Follow-Up Areas

- How Maya evaluates tradeoffs during migrations.
- How she measures reliability and operational success.
- How she handles disagreement in architecture reviews.
- Depth of experience with incident response and production ownership.

## Job Opportunity

**Company:** Greenfield Health
**Role:** Staff Backend Engineer, Care Platform
**Team:** Scheduling, eligibility, and patient communications

### Role Goals

- Improve reliability of high-volume scheduling APIs.
- Lead design reviews for cross-team backend projects.
- Coach senior engineers and raise engineering standards.
- Partner with product and clinical operations on workflow automation.

### Interview Focus

- Systems design judgment.
- Technical leadership and mentoring.
- Operational rigor.
- Product empathy in healthcare workflows.
- Clear communication under ambiguity.`;

export function App() {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(
    readCallIdFromLocation(),
  );
  const [selectedCall, setSelectedCall] = useState<CallDetail | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<TimelineItem[]>([]);
  const [connection, setConnection] = useState<ConnectionState>({
    status: "pending",
    label: "Loading",
  });
  const [formMessage, setFormMessage] = useState<{
    text: string;
    isError: boolean;
  }>({ text: "", isError: false });
  const [isCreating, setIsCreating] = useState(false);
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [streamLabel, setStreamLabel] = useState("Stream off");

  async function loadCalls(nextSelectedCallId = selectedCallId) {
    setConnection({ status: "pending", label: "Loading" });
    const nextCalls = await fetchCalls();
    setCalls(nextCalls);
    setConnection({ status: "connected", label: "Ready" });

    if (nextSelectedCallId) {
      await selectCall(nextSelectedCallId, false);
    } else if (!selectedCallId && nextCalls[0]) {
      await selectCall(nextCalls[0].id, true);
    }
  }

  async function selectCall(callId: string, pushState: boolean) {
    setSelectedCallId(callId);
    const call = await fetchCall(callId);
    setSelectedCall(call);
    setTimelineEvents(buildInitialTimeline(call));
    setStreamEnabled(call.status !== "completed");
    if (pushState) {
      window.history.pushState(
        {},
        "",
        `/app/calls/${encodeURIComponent(callId)}`,
      );
    }
  }

  useEffect(() => {
    loadCalls().catch((error: unknown) => {
      setConnection({
        status: "error",
        label: getErrorMessage(error),
      });
    });

    const onPopState = () => {
      const callId = readCallIdFromLocation();
      if (callId) {
        selectCall(callId, false).catch((error: unknown) => {
          setConnection({
            status: "error",
            label: getErrorMessage(error),
          });
        });
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (
      !selectedCallId ||
      !streamEnabled ||
      selectedCall?.status === "completed"
    ) {
      setStreamLabel("Stream off");
      return undefined;
    }

    const source = new EventSource(
      `/calls/${encodeURIComponent(selectedCallId)}/stream`,
    );
    setStreamLabel("Streaming");

    const handleTimelineEvent = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as StreamEvent;
      if (event.type === "call_update") {
        return;
      }

      setTimelineEvents((currentEvents) =>
        [...currentEvents.filter((item) => item.id !== event.id), event].sort(
          compareTimelineItems,
        ),
      );
    };

    const handleCallUpdate = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as Extract<
        StreamEvent,
        { type: "call_update" }
      >;

      setCalls((currentCalls) => mergeCallListUpdate(currentCalls, event.data));
      setSelectedCall((currentCall) =>
        currentCall?.id === event.data.id
          ? mergeSelectedCallUpdate(currentCall, event.data)
          : currentCall,
      );
      if (isTerminalCallStatus(event.data.status)) {
        setStreamEnabled(false);
      }
    };

    source.addEventListener("transcript", handleTimelineEvent);
    source.addEventListener("suggestion", handleTimelineEvent);
    source.addEventListener("call_update", handleCallUpdate);
    source.onerror = () => setStreamLabel("Stream retry");

    return () => {
      source.close();
    };
  }, [selectedCallId, selectedCall?.status, streamEnabled]);

  const activeCallCount = calls.length;
  const renderedTimeline = useMemo(
    () =>
      mergeAdjacentTranscriptItems(
        [...timelineEvents].sort(compareTimelineItems),
      ),
    [timelineEvents],
  );

  async function handleCreateCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const contextPrompt = String(form.get("contextPrompt") || "").trim();
    const conferenceName = String(form.get("conferenceName") || "").trim();
    if (!contextPrompt) {
      setFormMessage({ text: "Context is required", isError: true });
      return;
    }

    setIsCreating(true);
    setFormMessage({ text: "Creating", isError: false });
    try {
      const call = await createCall({
        contextPrompt,
        ...(conferenceName ? { conferenceName } : {}),
      });
      formElement.reset();
      setFormMessage({ text: "Created", isError: false });
      await loadCalls(call.id);
      await selectCall(call.id, true);
    } catch (error) {
      setFormMessage({ text: getErrorMessage(error), isError: true });
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>Geekhunter Interview Assistant</h1>
          <span>Live calls</span>
        </div>
        <div className="topbar-actions">
          <span className="status-pill">
            <span className={`status-dot ${connection.status}`}></span>
            <span>{connection.label}</span>
          </span>
          <button
            type="button"
            onClick={() =>
              loadCalls().catch((error: unknown) =>
                setConnection({
                  status: "error",
                  label: getErrorMessage(error),
                }),
              )
            }
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <section className="create-panel">
            <div className="section-title">
              <h2>Create Call</h2>
            </div>
            <form onSubmit={handleCreateCall}>
              <div className="field">
                <label htmlFor="conferenceName">Conference</label>
                <input
                  id="conferenceName"
                  name="conferenceName"
                  type="text"
                  defaultValue="interview-maya-chen"
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label htmlFor="contextPrompt">Context</label>
                <textarea
                  id="contextPrompt"
                  name="contextPrompt"
                  defaultValue={defaultContextPrompt}
                ></textarea>
              </div>
              <div className="form-actions">
                <span
                  className={`form-message ${formMessage.isError ? "error" : ""}`}
                >
                  {formMessage.text}
                </span>
                <button className="primary" type="submit" disabled={isCreating}>
                  Create
                </button>
              </div>
            </form>
          </section>

          <section className="call-list-panel">
            <div className="call-list-header">
              <strong>Active Calls</strong>
              <span className="status-pill">
                <span>{activeCallCount}</span>
              </span>
            </div>
            <ul className="call-list">
              {calls.length === 0 ? (
                <li className="empty-state">No active calls</li>
              ) : (
                calls.map((call) => (
                  <li key={call.id}>
                    <a
                      className={`call-item ${
                        call.id === selectedCallId ? "active" : ""
                      }`}
                      href={`/app/calls/${encodeURIComponent(call.id)}`}
                      onClick={(event) => {
                        event.preventDefault();
                        selectCall(call.id, true).catch((error: unknown) =>
                          setConnection({
                            status: "error",
                            label: getErrorMessage(error),
                          }),
                        );
                      }}
                    >
                      <span className="call-item-main">
                        <span className="call-name">
                          {call.conferenceName || call.id}
                        </span>
                        <StatusBadge status={call.status} />
                      </span>
                      <span className="call-meta">
                        {call.dialInNumber || "-"} ·{" "}
                        {formatDate(call.startedAt)}
                      </span>
                    </a>
                  </li>
                ))
              )}
            </ul>
          </section>
        </aside>

        <main className="detail">
          {selectedCall ? (
            <CallDetailView
              call={selectedCall}
              streamLabel={streamLabel}
              streamEnabled={streamEnabled}
              onToggleStream={() => setStreamEnabled((enabled) => !enabled)}
            />
          ) : null}

          <section className="timeline-shell">
            {!selectedCall ? (
              <div className="empty-state">Select a call</div>
            ) : (
              <Timeline events={renderedTimeline} />
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function CallDetailView(props: {
  call: CallDetail;
  streamLabel: string;
  streamEnabled: boolean;
  onToggleStream: () => void;
}) {
  return (
    <section className="detail-header">
      <div className="detail-title">
        <div>
          <h2>{props.call.conferenceName || props.call.id}</h2>
          <div className="detail-meta">
            <StatusBadge status={props.call.status} />
          </div>
        </div>
        <div className="detail-actions">
          <button type="button" onClick={props.onToggleStream}>
            {props.streamEnabled ? props.streamLabel : "Stream off"}
          </button>
        </div>
      </div>

      <div className="metric-grid">
        <Metric label="Status" value={formatStatus(props.call.status)} />
        <Metric label="Dial-In" value={props.call.dialInNumber || "-"} />
        <Metric label="Started" value={formatDate(props.call.startedAt)} />
        <Metric
          label="Provider Call"
          value={props.call.providerCallId || "-"}
        />
      </div>

      <div className="metric context-metric">
        <span>Context</span>
        <div className="markdown-content">
          <ReactMarkdown>{props.call.contextPrompt}</ReactMarkdown>
        </div>
      </div>
    </section>
  );
}

function Timeline(props: { events: TimelineItem[] }) {
  if (props.events.length === 0) {
    return (
      <div className="timeline">
        <div className="empty-state">No transcript or suggestions yet</div>
      </div>
    );
  }

  return (
    <div className="timeline">
      {props.events.map((event) =>
        event.type === "suggestion" ? (
          <SuggestionEntry key={event.id} event={event} />
        ) : (
          <TranscriptEntry key={event.id} event={event} />
        ),
      )}
    </div>
  );
}

function TranscriptEntry(props: {
  event: Extract<TimelineItem, { type: "transcript" }>;
}) {
  const data = props.event.data;
  const confidence =
    typeof data.confidence === "number"
      ? ` · ${Math.round(data.confidence * 100)}%`
      : "";

  return (
    <article className="timeline-entry transcript">
      <div className="timeline-entry-header">
        <span className="timeline-entry-title">
          {String(data.speaker || "speaker")}
        </span>
        <span className="timeline-meta">
          {formatDate(String(data.createdAt || props.event.occurredAt))}
          {confidence}
        </span>
      </div>
      <p>{String(data.text || "")}</p>
    </article>
  );
}

function SuggestionEntry(props: {
  event: Extract<TimelineItem, { type: "suggestion" }>;
}) {
  const data = props.event.data;
  const meta = [data.priority, data.competency].filter(Boolean).join(" · ");

  return (
    <article className="timeline-entry suggestion">
      <div className="timeline-entry-header">
        <span className="timeline-entry-title">Suggestion</span>
        <span className="timeline-meta">
          {meta || formatDate(String(data.createdAt || props.event.occurredAt))}
        </span>
      </div>
      <p>{String(data.text || "")}</p>
      {data.reason ? (
        <p className="timeline-meta">{String(data.reason)}</p>
      ) : null}
    </article>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function StatusBadge(props: { status: string }) {
  return (
    <span className={`badge ${props.status}`}>
      {formatStatus(props.status)}
    </span>
  );
}

function buildInitialTimeline(call: CallDetail): TimelineItem[] {
  const transcript: TimelineItem[] = call.transcript.map((segment) => ({
    type: "transcript",
    id: segment.id,
    callId: call.id,
    sequence: segment.startedAtMs,
    occurredAt: segment.createdAt,
    data: segment,
  }));
  const suggestions: TimelineItem[] = call.suggestions.map((suggestion) => ({
    type: "suggestion",
    id: suggestion.id,
    callId: call.id,
    sequence: Number.MAX_SAFE_INTEGER,
    occurredAt: suggestion.createdAt,
    data: suggestion,
  }));
  return [...transcript, ...suggestions].sort(compareTimelineItems);
}

function compareTimelineItems(left: TimelineItem, right: TimelineItem): number {
  const leftSequence = Number(left.sequence || 0);
  const rightSequence = Number(right.sequence || 0);
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  return (
    new Date(left.occurredAt || 0).getTime() -
    new Date(right.occurredAt || 0).getTime()
  );
}

function mergeAdjacentTranscriptItems(events: TimelineItem[]): TimelineItem[] {
  const mergedEvents: TimelineItem[] = [];

  for (const event of events) {
    const previousEvent = mergedEvents[mergedEvents.length - 1];
    if (
      previousEvent?.type === "transcript" &&
      event.type === "transcript" &&
      getTranscriptSpeaker(previousEvent) === getTranscriptSpeaker(event)
    ) {
      mergedEvents[mergedEvents.length - 1] = mergeTranscriptItems(
        previousEvent,
        event,
      );
      continue;
    }

    mergedEvents.push(event);
  }

  return mergedEvents;
}

function mergeTranscriptItems(
  previous: TimelineTranscriptItem,
  next: TimelineTranscriptItem,
): TimelineTranscriptItem {
  const confidences = [previous.data.confidence, next.data.confidence].filter(
    (confidence): confidence is number => typeof confidence === "number",
  );
  const confidence =
    confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null;

  return {
    ...previous,
    id: `${previous.id}:${next.id}`,
    data: {
      ...previous.data,
      text: joinTranscriptText(previous.data.text, next.data.text),
      isFinal: previous.data.isFinal !== false && next.data.isFinal !== false,
      endedAtMs: next.data.endedAtMs ?? previous.data.endedAtMs,
      confidence,
      createdAt: next.data.createdAt ?? previous.data.createdAt,
    },
  };
}

function getTranscriptSpeaker(event: TimelineTranscriptItem): string {
  return String(event.data.speaker || "speaker");
}

function joinTranscriptText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  return [previousText, nextText]
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}

function mergeCallListUpdate(
  calls: CallSummary[],
  update: CallUpdateData,
): CallSummary[] {
  if (isTerminalCallStatus(update.status)) {
    return calls.filter((call) => call.id !== update.id);
  }

  return calls.map((call) =>
    call.id === update.id
      ? {
          ...call,
          ...update,
        }
      : call,
  );
}

function mergeSelectedCallUpdate(
  call: CallDetail,
  update: CallUpdateData,
): CallDetail {
  return {
    ...call,
    ...update,
  };
}

function isTerminalCallStatus(status: string): boolean {
  return status === "completed" || status === "failed";
}

function readCallIdFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/app\/calls\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatStatus(status: string): string {
  return String(status || "unknown").replace(/_/g, " ");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
