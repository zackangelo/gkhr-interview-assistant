# Interview Assistant Voice Agent Plan

## Goal

Build a Node.js TypeScript server using Hono that can join a live interview call through Telnyx, transcribe the call with Deepgram, generate interviewer coaching suggestions with Mixlayer's OpenAI-compatible chat completions API, and expose call state plus live updates to a browser UI.

The server is an interviewer-side assistant. It should not speak into the call at first. Its primary output is a real-time web UI stream containing:

- diarized transcript segments from the live conversation
- agent suggestions inserted into the same timeline

## Current External API Assumptions

- Telnyx Call Control can answer calls and start media streaming to our WebSocket server.
- Telnyx media streaming should be treated as the ingress audio transport from the conference call into our app.
- Deepgram streaming transcription supports diarization. We should still design defensively because diarization quality and channel separation may vary by call setup.
- Mixlayer exposes an OpenAI-compatible REST API at a `/v1/chat/completions` style endpoint, so we can start with a small provider wrapper instead of the Modelsocket SDK.

Provider docs checked while writing this plan:

- Telnyx media streaming: https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
- Deepgram diarization: https://developers.deepgram.com/docs/diarization
- Deepgram streaming feature overview: https://developers.deepgram.com/docs/stt-streaming-feature-overview
- Mixlayer docs: https://docs.mixlayer.com/

## Non-Goals For The First Version

- No voice response or audio injection back into the call.
- No production database requirement at first; use an in-memory datastore with an interface that can be replaced.
- No full authentication system for the initial local prototype, though webhook signature verification and UI auth should be planned before production.
- No ATS/context retrieval integration inside this service initially. The caller of `POST /calls` provides the full LLM context prompt.
- No custom diarization model. Use Deepgram diarization and call metadata first, then evaluate improvements.

## Proposed Architecture

The first implementation should be a single Hono server with a small set of internal services:

- `CallStore`: tracks active and completed calls, transcripts, summaries, connected UI streams, and lifecycle state.
- `TelnyxService`: handles incoming webhooks, answers calls, starts media streaming, and maps Telnyx call identifiers to internal call records.
- `MediaStreamHandler`: accepts Telnyx WebSocket media events and forwards audio frames into the transcription pipeline.
- `DeepgramTranscriber`: owns the Deepgram streaming WebSocket connection and emits normalized transcript segments.
- `TranscriptService`: assembles transcript segments into a durable ordered transcript with speaker labels, timestamps, confidence, and final/interim state.
- `SuggestionEngine`: periodically calls Mixlayer with call context and transcript deltas, then emits structured suggestions.
- `EventBus`: publishes normalized call events to SSE clients.

Keep the boundaries explicit even if the first version lives in a few files. This keeps the prototype easy to split later.

The in-memory datastore should be intentionally shaped like a future Postgres-backed repository. Avoid APIs that depend on object identity, in-process timers as the only source of truth, or direct mutation of stored records. Prefer explicit repository methods, serializable records, stable IDs, and append-style event writes where practical.

## Runtime Flow

1. The client calls `POST /calls` to create an interview assistant session.
2. The server creates a pending internal call record using the supplied context prompt and returns dial-in instructions using a provisioned Telnyx number.
3. Interview participants call the Telnyx number, and Telnyx sends a webhook to `POST /answerCall`.
4. The server validates the webhook, extracts Telnyx call identifiers, and attaches the provider call leg to the pending call record.
5. For `call.initiated`, the server answers the call leg through `POST /v2/calls/:call_control_id/actions/answer`.
6. After `call.answered`, the server creates the Telnyx conference bridge from that answered leg through `POST /v2/conferences`.
7. Later participant legs are answered and joined to the existing bridge through `POST /v2/conferences/:conference_id/actions/join`.
8. The server starts Telnyx media streaming on the selected call leg.
9. Telnyx connects to our WebSocket media endpoint and sends audio events.
10. The media handler normalizes the audio payload and forwards it to Deepgram.
11. Deepgram emits interim and final transcript results.
12. The transcript service stores diarized transcript segments with provider speaker labels and optional best-effort roles.
13. Final transcript segments are stored and broadcast to UI subscribers.
14. The suggestion engine runs periodically and when meaningful transcript segments accumulate.
15. Mixlayer returns structured suggestions, which are stored and broadcast to UI subscribers.
16. When the call ends, the server closes provider streams, marks the call completed, and optionally generates a final summary.

## API Shape

### `POST /calls`

Creates a new pending interview assistant session and returns dial-in instructions.

This endpoint is the app-level source of truth. It should not assume a Telnyx conference already exists, because Telnyx conference creation requires an existing call leg. Instead, it creates an internal pending call record that later Telnyx webhooks attach real call legs to.

Initial request shape:

```json
{
  "contextPrompt": "Candidate: Jane Candidate\nRole: Senior Backend Engineer\nInterview focus: distributed systems, API design, and migration leadership.\nRelevant resume notes: ...",
  "conferenceName": "interview-int_789"
}
```

Initial response shape:

```json
{
  "call": {
    "id": "call_123",
    "status": "pending",
    "dialInNumber": "+12025550131",
    "conferenceName": "interview-int_789",
    "streamUrl": "/calls/call_123/stream"
  }
}
```

Implementation notes:

- `dialInNumber` is a configured/provisioned Telnyx number, not a newly purchased number.
- `conferenceName` should be unique or otherwise safely mapped to the internal call ID.
- If multiple pending calls can share the same dial-in number, the system needs a routing mechanism such as a conference code, expected caller numbers, or metadata in the `POST /calls` payload.
- Store `contextPrompt` immediately, so LLM context is ready before the first transcript segment arrives.

### `GET /calls`

Returns calls currently in progress.

Initial response shape:

```json
{
  "calls": [
    {
      "id": "call_123",
      "provider": "telnyx",
      "providerCallId": "telnyx_call_control_id",
      "status": "pending",
      "dialInNumber": "+12025550131",
      "conferenceName": "interview-int_789",
      "startedAt": "2026-05-19T12:00:00.000Z",
      "contextPreview": "Candidate: Jane Candidate; Role: Senior Backend Engineer",
      "lastActivityAt": "2026-05-19T12:02:00.000Z"
    }
  ]
}
```

### `GET /calls/:call_id`

Returns one call, including transcript and summary if available.

Initial response shape:

```json
{
  "call": {
    "id": "call_123",
    "status": "active",
    "contextPrompt": "Candidate: Jane Candidate\nRole: Senior Backend Engineer\nInterview focus: distributed systems...",
    "transcript": [
      {
        "id": "seg_123",
        "speaker": "speaker_1",
        "role": "unknown",
        "text": "I led the migration from...",
        "isFinal": true,
        "startedAtMs": 12000,
        "endedAtMs": 18500,
        "confidence": 0.94
      }
    ],
    "suggestions": [
      {
        "id": "sug_123",
        "text": "Ask how they measured migration success.",
        "reason": "The candidate mentioned leading a migration but has not described outcomes.",
        "createdAt": "2026-05-19T12:03:00.000Z"
      }
    ],
    "summary": null
  }
}
```

### `POST /answerCall`

Webhook listener from Telnyx.

Responsibilities:

- validate provider signature and event type
- parse the Telnyx webhook envelope: `data.record_type`, `data.event_type`, `data.id`, `data.occurred_at`, `data.payload`, and `meta`
- capture key Telnyx payload fields: `call_control_id`, `connection_id`, `call_leg_id`, `call_session_id`, `client_state`, `from`, `to`, `direction`, and `state`
- deduplicate repeated webhook deliveries using `data.id` and idempotent command IDs
- resolve the webhook to a pending internal call record using dialed number, expected caller, conference code, or `client_state`
- attach the Telnyx call leg to the internal call record
- answer the call leg
- create or join the Telnyx conference bridge
- start media streaming
- return quickly after dispatching provider actions

The endpoint should not block on long-running transcription or LLM work.

Telnyx delivery constraints to design around:

- Webhooks are HTTP callbacks and use `POST` by default.
- Telnyx includes `Telnyx-Signature-Ed25519` and `Telnyx-Timestamp` headers for webhook verification.
- Webhooks may be duplicated, simultaneous, or delivered out of order.
- Non-2xx webhook responses can trigger retries or failover delivery.

### `GET /calls/:call_id/stream`

Streams live call events to the web UI using SSE-compatible framing.

Use `GET` so the browser UI can consume the stream through native `EventSource`.

Event types:

```text
event: transcript
data: {"segmentId":"seg_1","speaker":"speaker_0","role":"unknown","text":"Can you walk me through your last project?","isFinal":true}

event: transcript
data: {"segmentId":"seg_2","speaker":"speaker_1","role":"unknown","text":"I owned the API migration...","isFinal":true}

event: suggestion
data: {"suggestionId":"sug_1","text":"Ask what tradeoffs they considered.","reason":"They described a technical decision without alternatives."}
```

The stream should be an ordered timeline of diarized transcript segments and inserted LLM suggestions. Do not model transcript events as `interviewer_question` or `candidate_response`; the conversation may include clarifications, setup chatter, interruptions, or other speech acts.

## WebSocket Endpoints

The public API list does not include the Telnyx media WebSocket endpoint, but the server will need one.

Proposed endpoint:

- `GET /telnyx/media/:call_id` or `GET /media/telnyx/:call_id`

Responsibilities:

- accept the Telnyx WebSocket upgrade
- associate the stream with an internal call record
- parse Telnyx media events
- forward audio frames to Deepgram
- handle call end, stream stop, and reconnect events

## Diarization Strategy

Start with three layers, from simplest to more robust:

1. Enable Deepgram diarization on the streaming transcription connection.
2. Preserve raw Deepgram speaker labels in the transcript model.
3. Add a best-effort speaker-role mapper later if useful, but keep transcript streaming based on speaker labels rather than hard-coded interviewer/candidate event types.

The role mapper should be explicit and revisable. Example heuristics:

- the first question-like segment is likely interviewer
- longer explanatory answers after interviewer questions are likely candidate
- known interviewer/candidate audio channels should override heuristics if Telnyx can provide separated tracks
- UI should expose uncertain speaker labels as `unknown` rather than pretending confidence is high

Open question for implementation: determine whether the Telnyx conference setup can provide separate audio tracks or metadata for interviewer and candidate. If yes, prefer multichannel transcription over diarization-only role inference.

The LLM may use the diarized transcript and context prompt to infer useful coaching opportunities, but the server should not require reliable role classification before it can stream transcripts.

## Suggestion Engine

The first version should call Mixlayer on a conservative cadence:

- after final transcript content accumulates past a configured threshold
- no more often than every 15-30 seconds per call
- immediately after important interview milestones, such as the first substantive answer

Prompt inputs:

- context prompt text supplied to `POST /calls`
- recent transcript window
- compact running summary
- previously suggested questions, to avoid repeats

Expected model output should be structured JSON:

```json
{
  "suggestions": [
    {
      "text": "Ask how they validated the migration improved reliability.",
      "reason": "They mentioned a migration but not the success metric.",
      "priority": "medium",
      "competency": "technical_depth"
    }
  ]
}
```

If Mixlayer returns malformed JSON, the provider wrapper should retry once with a repair prompt or fall back to plain text parsing.

## Data Model

Initial in-memory entities:

- `Call`
  - `id`
  - `provider`
  - `dialInNumber`
  - `conferenceName`
  - `providerCallId`
  - `providerCallLegId`
  - `providerCallSessionId`
  - `providerConferenceId`
  - `providerSessionId`
  - `status`
  - `contextPrompt`
  - `startedAt`
  - `endedAt`
  - `lastActivityAt`
- `TranscriptSegment`
  - `id`
  - `callId`
  - `speaker`
  - `role`
  - `providerSpeakerLabel`
  - `text`
  - `isFinal`
  - `startedAtMs`
  - `endedAtMs`
  - `confidence`
  - `createdAt`
- `Suggestion`
  - `id`
  - `callId`
  - `text`
  - `reason`
  - `priority`
  - `competency`
  - `sourceSegmentIds`
  - `createdAt`
- `CallSummary`
  - `callId`
  - `text`
  - `updatedAt`

## Configuration

Use environment variables for the first version:

- `PORT`
- `PUBLIC_BASE_URL`
- `TELNYX_API_KEY`
- `TELNYX_CONNECTION_ID`
- `TELNYX_DIAL_IN_NUMBER`
- `TELNYX_WEBHOOK_PUBLIC_KEY` or equivalent signature validation config
- `DEEPGRAM_API_KEY`
- `DEEPGRAM_MODEL`
- `MIXLAYER_API_KEY`
- `MIXLAYER_BASE_URL`
- `MIXLAYER_MODEL`

## Implementation Phases

### Phase 1: Project Skeleton (Completed)

- [x] Initialize TypeScript, Hono, formatting, and test tooling.
- [x] Add configuration loading and validation.
- [x] Add basic health endpoint.
- [x] Define core domain types and datastore interface.

### Phase 2: Call API And Store (Completed)

- [x] Implement in-memory `CallStore`.
- [x] Implement `POST /calls` to create pending assistant sessions and return dial-in instructions.
- [x] Implement `GET /calls`.
- [x] Implement `GET /calls/:call_id`.
- [x] Add basic unit tests for call lifecycle and transcript append behavior.

### Phase 3: SSE Event Stream (Completed)

- [x] Implement per-call event bus.
- [x] Implement call event publishing for ordered `transcript` and `suggestion` events.
- [x] Implement `GET /calls/:call_id/stream` using SSE.
- [x] Add a small manual test client or documented `curl` workflow.

### Phase 4: Telnyx Webhook And Media Stream (Completed)

- [x] Implement `POST /answerCall`.
- [x] Add webhook validation and idempotency.
- [x] Add pending-call resolution from Telnyx webhook data.
- [x] Add Telnyx REST client wrapper for answer/create-conference/join-conference/start-stream actions.
- [x] Add Telnyx media WebSocket endpoint.
- [x] Store raw provider lifecycle events for debugging.

### Phase 5: Deepgram Transcription

- [x] Implement Deepgram streaming client.
- [x] Pipe Telnyx audio frames into Deepgram.
- [x] Normalize interim and final transcript events.
- [x] Enable diarization and preserve provider speaker labels.
- [x] Broadcast transcript segments as ordered diarized `transcript` events.

Implementation notes:

- The app now uses the official `@deepgram/sdk` live transcription connection when `DEEPGRAM_API_KEY` is set.
- Telnyx `PCMU` media is sent to Deepgram as raw `mulaw` audio with `sample_rate: 8000`.
- Telnyx inbound and outbound tracks are transcribed with separate Deepgram sessions so track direction is preserved instead of mixing both tracks into one mono stream.
- Deepgram diarization labels are preserved as `providerSpeakerLabel`; app-level speaker names include the Telnyx track, such as `telnyx_inbound_speaker_0`.
- Interim and final transcript updates reuse the same transcript segment id when Deepgram reports the same track, speaker, and start time. This lets the UI replace interim text with final text later.
- Unit coverage uses mocked transcribers; live Deepgram validation against a real Telnyx call is still pending.
- Local verification passed with `npm run typecheck`, `npm test`, `npm run format`, and `npm run build`.

Follow-up TODO:

- [ ] Improve transcript reconciliation so an interim segment can be replaced by a nearby final segment from the same Telnyx track and Deepgram speaker even when Deepgram shifts the reported segment start time. Live test `8a9059c1-5e99-4d58-9d21-ce3aaaf851f7` left both interim `"Anyone"` and final `"Anyone there?"` because the start moved from `5050ms` to `5130ms`.

### Phase 6: Mixlayer Suggestions

- [x] Implement OpenAI-compatible chat completions wrapper.
- [x] Add prompt builder with context, transcript window, running summary, and previous suggestions.
- [x] Add cadence/rate limiting per call.
- [x] Store and broadcast suggestions.
- [x] Add tests around prompt construction and malformed model output handling.

Implementation notes:

- The app now uses a small OpenAI-compatible chat completions wrapper for Mixlayer rather than the Modelsocket SDK.
- The default base URL is `https://models.mixlayer.ai/v1`; the default prototype model is `qwen/qwen3.5-4b-free`.
- Suggestions are triggered only from final transcript segments and are disabled unless `MIXLAYER_API_KEY` is configured.
- The first substantive final segment can trigger suggestions immediately; later generations use per-call interval and accumulated-transcript thresholds.
- The prompt includes the call context, recent diarized transcript, transcript delta since the previous suggestion request, running summary if available, and previous suggestions.
- Model output is requested as JSON schema. Malformed JSON falls back to parsing plain-text lines as suggestions.
- Duplicate suggestion text is filtered before storing and broadcasting.
- Local verification passed with `npm run typecheck`, `npm test`, `npm run format`, and `npm run build`.

### Phase 7: Summary And Completion

- Detect call end events from Telnyx.
- Close Deepgram and UI streams cleanly.
- Generate final summary through Mixlayer.
- Mark calls completed and decide retention behavior.

### Phase 8: Web UI

- Build a minimal UI that lists active calls.
- Add call detail view with live transcript.
- Render diarized transcript segments and inserted suggestions as one ordered timeline.
- Show speaker uncertainty clearly.
- Add reconnect behavior for stream interruptions.

### Phase 9: Production Hardening

- Replace in-memory store with persistent storage.
- Add authentication for UI and internal APIs.
- Add webhook signature verification tests with fixtures.
- Add structured logs and call-level tracing.
- Add provider retry/backoff policies.
- Add PII retention controls and transcript deletion workflow.
- Add load testing for concurrent calls.

## Testing Strategy

- Unit tests for call state transitions, transcript assembly, event bus behavior, suggestion cadence, and prompt construction.
- Integration tests with mocked Telnyx, Deepgram, and Mixlayer clients.
- Contract fixtures for provider webhooks and media events.
- Manual end-to-end test with a Telnyx test number once credentials are available.
- Browser test for UI stream rendering once the UI exists.

## Telnyx Research Findings

### Conferencing Flow

Telnyx supports creating and joining conferences through Voice API conference commands.

- `POST /v2/calls/:call_control_id/actions/answer` answers an inbound Call Control leg. This is required before the caller stops hearing ringback.
- `POST /v2/conferences` creates a conference from an existing call leg using `call_control_id` and automatically bridges that call leg into the conference.
- `POST /v2/conferences/:id/actions/join` joins another existing call leg into the conference.
- The join command accepts `client_state`, `command_id`, `hold`, `mute`, `start_conference_on_enter`, `end_conference_on_exit`, and `supervisor_role`.
- `supervisor_role: "monitor"` lets a participant hear all participants while muted. This is likely the right mode if the assistant must be conferenced in as a passive listener.
- `supervisor_role: "whisper"` exists if we later want the assistant to speak only to selected participants, but that is out of scope for the first version.

Implications:

- `POST /calls` in our API can create a pending assistant session and return a configured Telnyx dial-in number.
- The live Telnyx conference bridge cannot be fully created until at least one call leg exists, because Telnyx `POST /v2/conferences` requires `call_control_id`.
- When the first participant calls in, `/answerCall` should answer the leg. After the `call.answered` webhook arrives, create the Telnyx conference from that leg.
- Later participant legs should also be answered first, then joined with `POST /v2/conferences/:id/actions/join`.
- If the existing interview already runs through Telnyx Call Control, attach media streaming to the relevant call leg and avoid adding a new audible participant.
- If the product requirement requires the assistant to be a conference participant, join an assistant-controlled call leg to the conference as `supervisor_role: "monitor"` and stream media from that leg.

Confirmed first-leg API sequence:

1. Receive `call.initiated` with `payload.state: "parked"`.
2. Send `POST /v2/calls/:call_control_id/actions/answer`.
3. Receive `call.answered`.
4. Send `POST /v2/conferences` with the answered leg's `call_control_id` and the internal `conferenceName`.
5. Receive `conference.created` and `conference.participant.joined`.
6. Store the returned `conference_id` on the internal call.

Confirmed later-leg API sequence:

1. Receive another `call.initiated`.
2. Send `POST /v2/calls/:call_control_id/actions/answer`.
3. Receive `call.answered`.
4. Resolve the existing internal call and stored Telnyx `conference_id`.
5. Send `POST /v2/conferences/:conference_id/actions/join` with the new leg's `call_control_id`.

### Media Streaming And Tracks

Telnyx media streaming can be requested when dialing, answering, or by calling `POST /v2/calls/:call_control_id/actions/streaming_start`.

Relevant options:

- `stream_url`: WebSocket destination.
- `stream_track`: `inbound_track`, `outbound_track`, or `both_tracks`.
- `stream_codec`: `PCMU`, `PCMA`, `G722`, `OPUS`, `AMR-WB`, `L16`, or `default`.
- `stream_auth_token`: auth token sent as part of the WebSocket connection.
- `custom_parameters`: name/value metadata sent as part of the WebSocket connection.

The WebSocket flow includes:

- `connected`
- `start`, including `call_control_id`, `call_session_id`, `from`, `to`, `client_state`, `media_format`, and `stream_id`
- `media`, including `track`, `chunk`, `timestamp`, and base64 RTP payload
- `stop`
- optional `dtmf`, `mark`, and `error` events

Telnyx explicitly notes that media event order is not guaranteed and that `chunk` can be used to reorder events.

Important limitation: the docs show `media_format.channels: 1` and track values of inbound/outbound. That gives us call-leg direction separation, not guaranteed conference participant separation. We should still rely on Deepgram diarization unless an end-to-end Telnyx conference test proves separate participant tracks are available for our exact call topology.

Live test result on May 19, 2026:

- Telnyx successfully connected to `wss://zack-macbook-2024.tailbfe4ed.ts.net/media/telnyx/:call_id`.
- The stream delivered `media` events on both `inbound` and `outbound` tracks.
- The stream ended with a `stop` event followed by WebSocket close code `1005`.
- The app captured media frames with monotonically increasing `sequence_number` values.
- The observed stream used one stream ID for both tracks: `d96484ea-a86d-4ec6-b4ee-5415faefdf09`.

This confirms that Phase 5 should consume Telnyx WebSocket media events directly from `/media/telnyx/:call_id`, decode the base64 RTP payload, and forward the audio frames to Deepgram.

### Conference Metadata

Conference APIs and webhooks provide useful correlation metadata:

- `conference.participant.joined` includes `call_control_id`, `connection_id`, `call_leg_id`, `call_session_id`, `client_state`, and `conference_id`.
- Listing conference participants returns participant records with `id`, `call_control_id`, `call_leg_id`, `status`, `muted`, `on_hold`, `conference.id`, and `conference.name`.
- Conference creation can emit `conference.created`, `conference.participant.joined`, `conference.participant.left`, `conference.ended`, `conference.recording.saved`, and `conference.floor.changed`.

These fields are useful for call lifecycle tracking and participant correlation, but the docs reviewed do not establish a reliable mapping from media frames to individual conference participants.

### Observed Telnyx Webhook Payloads

Observed through the local `/answerCall` webhook behind Tailscale Funnel on May 19, 2026.

Inbound `call.initiated` example:

```json
{
  "data": {
    "event_type": "call.initiated",
    "id": "9f9301c2-a9db-41bf-a670-013af4c67e3a",
    "occurred_at": "2026-05-19T23:30:15.038431Z",
    "payload": {
      "call_control_id": "v3:CM8u1zCcmtZ3Jzb6vuXBSzCLS5p7ww8ypCUpyBJVrubAVjjLAAECYg",
      "call_leg_id": "b0457f28-53da-11f1-9961-02420aef271f",
      "call_session_id": "b04574f6-53da-11f1-8e4b-02420aef271f",
      "caller_id_name": "+15129342627",
      "calling_party_type": "pstn",
      "client_state": null,
      "connection_codecs": "PCMU,PCMA,G729",
      "connection_id": "2963572552552678752",
      "direction": "incoming",
      "from": "+15129342627",
      "from_sip_uri": "+15129342627@206.147.72.186:5060",
      "offered_codecs": "AMR-WB~OCTET-ALIGN=0; MODE-SET=0,16000H,AMR-WB~OCTET-ALIGN=1; MODE-SET=0,16000H,PCMU,G729",
      "start_time": "2026-05-19T23:30:15.038431Z",
      "state": "parked",
      "to": "+15122548727",
      "to_sip_uri": "+15122548727@us.icp.telnyx.com:5060"
    },
    "record_type": "event"
  },
  "meta": {
    "attempt": 1,
    "delivered_to": "https://zack-macbook-2024.tailbfe4ed.ts.net/answerCall"
  }
}
```

Observed headers included:

```json
{
  "content-type": "application/json",
  "telnyx-signature-ed25519": "...",
  "telnyx-timestamp": "1779233415",
  "user-agent": "telnyx-webhooks",
  "x-forwarded-host": "zack-macbook-2024.tailbfe4ed.ts.net",
  "x-forwarded-proto": "https"
}
```

Because the app did not yet answer the call, the caller hung up and Telnyx sent `call.hangup`:

```json
{
  "data": {
    "event_type": "call.hangup",
    "id": "08464bf3-4e98-41f5-b526-09e9b04a66c7",
    "occurred_at": "2026-05-19T23:30:23.738431Z",
    "payload": {
      "call_control_id": "v3:CM8u1zCcmtZ3Jzb6vuXBSzCLS5p7ww8ypCUpyBJVrubAVjjLAAECYg",
      "call_leg_id": "b0457f28-53da-11f1-9961-02420aef271f",
      "call_session_id": "b04574f6-53da-11f1-8e4b-02420aef271f",
      "connection_id": "2963572552552678752",
      "end_time": "2026-05-19T23:30:23.738431Z",
      "from": "+15129342627",
      "hangup_cause": "originator_cancel",
      "hangup_source": "caller",
      "sip_hangup_cause": "487",
      "start_time": "2026-05-19T23:30:15.038431Z",
      "telnyx_error": null,
      "to": "+15122548727"
    },
    "record_type": "event"
  },
  "meta": {
    "attempt": 1,
    "delivered_to": "https://zack-macbook-2024.tailbfe4ed.ts.net/answerCall"
  }
}
```

Implementation implications:

- `call.initiated` arrives with `payload.state: "parked"` for inbound calls.
- Ringback continues until the server sends the Answer command.
- Store `data.id` for webhook idempotency.
- Store `payload.call_control_id`, `payload.call_leg_id`, `payload.call_session_id`, `payload.connection_id`, `payload.from`, and `payload.to`.
- Preserve Telnyx signature headers for verification tests, but do not store full request headers in production.

### Live Telnyx Integration Test

Completed on May 19, 2026 using:

- Dial-in number: `+15122548727`
- Internal call ID: `e1e950a9-d995-441f-931c-752628bb62f8`
- Conference name: `test-interview-bridge`

Observed event sequence:

1. `call.initiated`
2. `call.answered`
3. `conference.floor.changed`
4. `streaming.started`
5. `conference.created`
6. `conference.participant.joined`
7. WebSocket `media` events on `inbound` and `outbound` tracks
8. WebSocket `stop`
9. `streaming.stopped`
10. `call.hangup`
11. `conference.participant.left`
12. `conference.ended`

Confirmed state after hangup:

- Call status: `completed`
- `providerCallId`: `v3:HcXFeJ34Z7VGDHDY-8xR8xsz1togxMxhlKObgbPUkKakdi6Eh0iWJQ`
- `providerCallLegId`: `6fc9bb8a-53df-11f1-af0f-02420aef961f`
- `providerCallSessionId`: `6fc9b1e4-53df-11f1-9ecd-02420aef961f`
- `providerConferenceId`: `d4be636f-dfb1-453b-8bca-18c88bd7a6b8`
- Hangup cause: `normal_clearing`
- Hangup source: `caller`

Confirmed behavior:

- Pending-call resolution by dial-in number worked for this single-call test.
- Answer command stopped ringback and produced `call.answered`.
- Create-conference command produced `conference.created` and `conference.participant.joined`.
- Streaming-start command produced `streaming.started`.
- Telnyx delivered media WebSocket frames until the caller hung up.
- No transcript or suggestion events were produced in this test because Deepgram and Mixlayer were not wired at the time.

Implementation implications:

- Phase 4 is validated end to end for a single inbound participant.
- Phase 5 starts from captured Telnyx media events rather than needing more Call Control plumbing.
- Multi-participant routing is still unvalidated and remains a design question for later participant legs.

### Webhook And Command Reliability

Telnyx command and webhook behavior reinforces the datastore design:

- Commands are issued against `call_control_id`.
- Commands can include `command_id` to avoid duplicate command execution.
- Webhooks can be duplicated, simultaneous, or out of order.
- Webhooks include `Telnyx-Signature-Ed25519` and `Telnyx-Timestamp`.

Implementation should persist processed webhook IDs, command IDs, provider IDs, and provider timestamps even in the in-memory version.

Telnyx docs used:

- https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
- https://developers.telnyx.com/api-reference/call-commands/answer-call
- https://developers.telnyx.com/api-reference/call-commands/streaming-start
- https://developers.telnyx.com/api-reference/conference-commands/create-conference
- https://developers.telnyx.com/api-reference/conference-commands/join-a-conference
- https://developers.telnyx.com/api-reference/conference-commands/list-conference-participants
- https://developers.telnyx.com/api-reference/callbacks/conference-participant-joined

## Key Open Questions

- Can the exact production call topology provide reliable participant-level audio separation, or only inbound/outbound tracks for a call leg?
- Should calls be retained after completion in the first version, or should completed calls be removed from memory?
- What latency target is acceptable for suggestions: near real-time, every answer, or periodic coaching?
- Should interviewer suggestions be purely question suggestions, or should they include evaluation notes and rubric coverage?

## Immediate Next Step

Live validation and Phase 7 preparation:

1. Place another Telnyx test call with `DEEPGRAM_API_KEY` and `MIXLAYER_API_KEY` configured and verify that `/calls/:call_id/stream` emits both transcript and suggestion events.
2. Inspect whether useful speech lands on `inbound`, `outbound`, or both tracks for the intended interview topology.
3. Decide whether suggestion cadence should stay threshold-based or be tuned around interview-specific milestones.
4. Decide the routing mechanism from inbound Telnyx webhook to pending internal call for multi-call or multi-participant scenarios: unique dial-in number, conference code, expected caller number, or provider metadata.
5. Decide completed-call retention behavior for the in-memory prototype.
