# GKHR Interview Assistant

Voice agent server for live interview transcription and interviewer coaching.

## Development

```sh
npm install
npm run dev
```

The server listens on `http://localhost:3000` by default.

Set `TELNYX_DIAL_IN_NUMBER` before using `POST /calls`:

```sh
TELNYX_DIAL_IN_NUMBER=+15122548727 npm run dev
```

Create a pending call:

```sh
curl -sS http://localhost:3000/calls \
  -H 'content-type: application/json' \
  -d '{"contextPrompt":"Candidate: Jane Candidate\nRole: Senior Backend Engineer","conferenceName":"interview-int_789"}'
```

Open the live call event stream:

```sh
curl -N http://localhost:3000/calls/{call_id}/stream
```

The stream emits ordered `transcript` and `suggestion` Server-Sent Events.
Transcript events are published from Deepgram results when `DEEPGRAM_API_KEY`
is set. Suggestion events are published from Mixlayer chat completions when
`MIXLAYER_API_KEY` is set.

The app loads `.env` automatically when started through `src/index.ts` or the
compiled `dist/index.js`.

Optional Mixlayer settings:

```sh
MIXLAYER_API_KEY=...
MIXLAYER_BASE_URL=https://models.mixlayer.ai/v1
MIXLAYER_MODEL=qwen/qwen3.5-4b-free
MIXLAYER_SUGGESTION_MIN_INTERVAL_MS=15000
MIXLAYER_SUGGESTION_MIN_TRANSCRIPT_CHARS=120
MIXLAYER_SUGGESTION_FIRST_SEGMENT_MIN_CHARS=40
```

## Local Telnyx Webhook Testing With Tailscale Funnel

Telnyx needs a publicly reachable webhook URL. For local development, use
Tailscale Funnel to expose the local server over HTTPS.

Find this machine's Tailscale hostname:

```sh
tailscale status --json | jq -r '.Self.DNSName'
```

The output will look like:

```text
my-laptop.example.ts.net.
```

Drop the trailing dot when building the public URL:

```text
https://my-laptop.example.ts.net
```

Start the local server:

```sh
npm run dev
```

In another terminal, create the public Funnel to the default local port:

```sh
tailscale funnel --bg 3000
```

Use the public URL plus the webhook route when configuring Telnyx. For example:

```text
https://my-laptop.example.ts.net/answerCall
```

For inbound Telnyx calls, create a pending app call before dialing the Telnyx
number. The webhook handler resolves inbound `call.initiated` events against
pending calls by dial-in number, answers the Telnyx call leg, creates or joins a
Telnyx conference after `call.answered`, and starts media streaming to:

```text
wss://my-laptop.example.ts.net/media/telnyx/{call_id}
```

To inspect whether the server received a webhook, open:

```text
https://my-laptop.example.ts.net/webhook-pings
```

To inspect raw Telnyx media WebSocket events captured for a call:

```text
https://my-laptop.example.ts.net/media/telnyx/{call_id}/events
```

To inspect transcript output after a call has media, use the call detail route:

```text
https://my-laptop.example.ts.net/calls/{call_id}
```

You can also smoke-test the receiver without Telnyx:

```sh
curl -X POST https://my-laptop.example.ts.net/answerCall \
  -H 'content-type: application/json' \
  -d '{"data":{"event_type":"test.ping","id":"local-test"}}'
```

Useful Funnel commands:

```sh
tailscale funnel status
tailscale funnel reset
```
