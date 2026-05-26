export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  responseFormat?: Record<string, unknown>;
  temperature?: number;
  maxCompletionTokens?: number;
}

export interface ChatCompletionClient {
  create(input: ChatCompletionRequest): Promise<string>;
}

interface OpenAICompatibleChatCompletionClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchFn?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

interface ErrorEnvelope {
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
}

export class OpenAICompatibleChatCompletionClient implements ChatCompletionClient {
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly options: OpenAICompatibleChatCompletionClientOptions,
  ) {
    this.endpoint = buildChatCompletionsEndpoint(options.baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async create(input: ChatCompletionRequest): Promise<string> {
    const response = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        max_completion_tokens: input.maxCompletionTokens ?? 700,
        response_format: input.responseFormat,
      }),
    });

    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(
        `Chat completion failed with status ${response.status}: ${readErrorMessage(body)}`,
      );
    }

    const content = (body as ChatCompletionResponse).choices?.[0]?.message
      ?.content;
    if (typeof content !== "string") {
      throw new Error("Chat completion response did not include text content.");
    }

    return content;
  }
}

export function buildChatCompletionsEndpoint(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, "");
  return trimmedBaseUrl.endsWith("/chat/completions")
    ? trimmedBaseUrl
    : `${trimmedBaseUrl}/chat/completions`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readErrorMessage(body: unknown): string {
  const error = (body as ErrorEnvelope | null)?.error;
  if (error && typeof error.message === "string") {
    return error.message;
  }

  if (typeof body === "string") {
    return body;
  }

  return "unknown error";
}
