# GKHR Interview Assistant

Voice agent server for live interview transcription and interviewer coaching.

## Development

```sh
npm install
npm run dev
```

The server listens on `http://localhost:3000` by default.

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

Useful Funnel commands:

```sh
tailscale funnel status
tailscale funnel reset
```
