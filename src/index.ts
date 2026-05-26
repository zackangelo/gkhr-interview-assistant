import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { config as loadDotenv } from "dotenv";

import { createApp, registerMediaWebSocketRoute } from "./app.js";
import { loadConfig } from "./config.js";
import { InMemoryCallEventBus } from "./events/call-event-bus.js";
import { InMemoryCallStore } from "./store/in-memory-call-store.js";
import { OpenAICompatibleChatCompletionClient } from "./suggestions/chat-completions-client.js";
import { CallSuggestionEngine } from "./suggestions/suggestion-engine.js";
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
const chatClient = config.mixlayerApiKey
  ? new OpenAICompatibleChatCompletionClient({
      apiKey: config.mixlayerApiKey,
      baseUrl: config.mixlayerBaseUrl,
      model: config.mixlayerModel,
    })
  : null;
const suggestionEngine = chatClient
  ? new CallSuggestionEngine({
      callStore,
      eventBus,
      chatClient,
      minIntervalMs: config.mixlayerSuggestionMinIntervalMs,
      minTranscriptChars: config.mixlayerSuggestionMinTranscriptChars,
      firstSegmentMinChars: config.mixlayerSuggestionFirstSegmentMinChars,
    })
  : null;
const app = createApp(config, { callStore, eventBus, mediaStreamStore });
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

registerMediaWebSocketRoute(app, {
  callStore,
  eventBus,
  mediaStreamStore,
  suggestionEngine,
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
