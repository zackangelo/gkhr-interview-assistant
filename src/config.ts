import { z } from "zod";

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  publicBaseUrl: z.string().url().optional(),
  telnyxApiKey: z.string().optional(),
  telnyxConnectionId: z.string().optional(),
  telnyxDialInNumber: z.string().optional(),
  telnyxWebhookPublicKey: z.string().optional(),
  deepgramApiKey: z.string().optional(),
  deepgramModel: z.string().default("nova-3"),
  mixlayerApiKey: z.string().optional(),
  mixlayerBaseUrl: z.string().url().default("https://models.mixlayer.ai/v1"),
  mixlayerModel: z.string().default("qwen/qwen3.5-4b-free"),
  mixlayerSuggestionMinIntervalMs: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(15_000),
  mixlayerSuggestionMinTranscriptChars: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(120),
  mixlayerSuggestionFirstSegmentMinChars: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(40),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse({
    port: env.PORT,
    publicBaseUrl: readOptionalEnv(env.PUBLIC_BASE_URL),
    telnyxApiKey: readOptionalEnv(env.TELNYX_API_KEY),
    telnyxConnectionId: readOptionalEnv(env.TELNYX_CONNECTION_ID),
    telnyxDialInNumber: readOptionalEnv(env.TELNYX_DIAL_IN_NUMBER),
    telnyxWebhookPublicKey: readOptionalEnv(env.TELNYX_WEBHOOK_PUBLIC_KEY),
    deepgramApiKey: readOptionalEnv(env.DEEPGRAM_API_KEY),
    deepgramModel: readOptionalEnv(env.DEEPGRAM_MODEL),
    mixlayerApiKey: readOptionalEnv(env.MIXLAYER_API_KEY),
    mixlayerBaseUrl: readOptionalEnv(env.MIXLAYER_BASE_URL),
    mixlayerModel: readOptionalEnv(env.MIXLAYER_MODEL),
    mixlayerSuggestionMinIntervalMs: env.MIXLAYER_SUGGESTION_MIN_INTERVAL_MS,
    mixlayerSuggestionMinTranscriptChars:
      env.MIXLAYER_SUGGESTION_MIN_TRANSCRIPT_CHARS,
    mixlayerSuggestionFirstSegmentMinChars:
      env.MIXLAYER_SUGGESTION_FIRST_SEGMENT_MIN_CHARS,
  });
}

function readOptionalEnv(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
