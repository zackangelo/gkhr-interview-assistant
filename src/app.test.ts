import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

describe("app", () => {
  it("returns health status", async () => {
    const app = createApp(loadConfig({ PORT: "3000" }));

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      service: "gkhr-interview-assistant",
    });
  });
});
