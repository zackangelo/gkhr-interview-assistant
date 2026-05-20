import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { config as loadDotenv } from "dotenv";

import { createApp, registerMediaWebSocketRoute } from "./app.js";
import { loadConfig } from "./config.js";
import { InMemoryCallEventBus } from "./events/call-event-bus.js";
import { InMemoryCallStore } from "./store/in-memory-call-store.js";
import { InMemoryMediaStreamStore } from "./telnyx/media-stream-store.js";
import { DeepgramStreamingTranscriber } from "./transcription/deepgram-transcriber.js";

loadDotenv({ path: new URL("../.env", import.meta.url), quiet: true });
const config = loadConfig();
const callStore = new InMemoryCallStore();
const eventBus = new InMemoryCallEventBus();
const mediaStreamStore = new InMemoryMediaStreamStore();
const transcriber = config.deepgramApiKey
  ? new DeepgramStreamingTranscriber({
      apiKey: config.deepgramApiKey,
      model: config.deepgramModel,
    })
  : null;
const app = createApp(config, { callStore, eventBus, mediaStreamStore });
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

registerMediaWebSocketRoute(app, {
  callStore,
  eventBus,
  mediaStreamStore,
  transcriber,
  upgradeWebSocket,
});

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);

injectWebSocket(server);
