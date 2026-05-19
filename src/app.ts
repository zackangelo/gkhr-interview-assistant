import { Hono } from "hono";

import type { AppConfig } from "./config.js";

export function createApp(config: AppConfig): Hono {
  const app = new Hono();

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

  return app;
}
