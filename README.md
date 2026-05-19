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
Transcript and suggestion events are published by the internal call event bus;
Telnyx, Deepgram, and Mixlayer integrations will feed this stream in later
phases.

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

To inspect whether the server received a webhook, open:

```text
https://my-laptop.example.ts.net/webhook-pings
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
