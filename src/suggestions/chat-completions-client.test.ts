import { describe, expect, it } from "vitest";

import {
  buildChatCompletionsEndpoint,
  OpenAICompatibleChatCompletionClient,
} from "./chat-completions-client.js";

describe("buildChatCompletionsEndpoint", () => {
  it("accepts either a base v1 URL or a full chat completions URL", () => {
    expect(buildChatCompletionsEndpoint("https://models.mixlayer.ai/v1")).toBe(
      "https://models.mixlayer.ai/v1/chat/completions",
    );
    expect(
      buildChatCompletionsEndpoint(
        "https://models.mixlayer.ai/v1/chat/completions",
      ),
    ).toBe("https://models.mixlayer.ai/v1/chat/completions");
  });
});

describe("OpenAICompatibleChatCompletionClient", () => {
  it("posts an OpenAI-compatible chat completion request", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new OpenAICompatibleChatCompletionClient({
      apiKey: "test-key",
      baseUrl: "https://models.mixlayer.ai/v1",
      model: "qwen/qwen3.5-4b-free",
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"suggestions":[]}',
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    const content = await client.create({
      messages: [{ role: "user", content: "hello" }],
      responseFormat: { type: "json_object" },
    });

    expect(content).toBe('{"suggestions":[]}');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://models.mixlayer.ai/v1/chat/completions",
    );
    expect(requests[0].init.headers).toMatchObject({
      authorization: "Bearer test-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      model: "qwen/qwen3.5-4b-free",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_object" },
    });
  });

  it("throws a useful error for provider failures", async () => {
    const client = new OpenAICompatibleChatCompletionClient({
      apiKey: "test-key",
      baseUrl: "https://models.mixlayer.ai/v1",
      model: "missing-model",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Model not found.",
              code: "model_not_found",
            },
          }),
          { status: 400 },
        ),
    });

    await expect(
      client.create({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow("Model not found.");
  });
});
