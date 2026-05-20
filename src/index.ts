import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { config as loadDotenv } from "dotenv";

import { createApp, registerMediaWebSocketRoute } from "./app.js";
import { loadConfig } from "./config.js";
import { InMemoryMediaStreamStore } from "./telnyx/media-stream-store.js";

loadDotenv({ path: new URL("../.env", import.meta.url), quiet: true });
const config = loadConfig();
const mediaStreamStore = new InMemoryMediaStreamStore();
const app = createApp(config, { mediaStreamStore });
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

registerMediaWebSocketRoute(app, {
  mediaStreamStore,
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
