import { z } from "zod";

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  publicBaseUrl: z.string().url().optional(),
  telnyxApiKey: z.string().optional(),
  telnyxConnectionId: z.string().optional(),
  telnyxWebhookPublicKey: z.string().optional(),
  deepgramApiKey: z.string().optional(),
  deepgramModel: z.string().default("nova-3"),
  mixlayerApiKey: z.string().optional(),
  mixlayerBaseUrl: z.string().url().optional(),
  mixlayerModel: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse({
    port: env.PORT,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    telnyxApiKey: env.TELNYX_API_KEY,
    telnyxConnectionId: env.TELNYX_CONNECTION_ID,
    telnyxWebhookPublicKey: env.TELNYX_WEBHOOK_PUBLIC_KEY,
    deepgramApiKey: env.DEEPGRAM_API_KEY,
    deepgramModel: env.DEEPGRAM_MODEL,
    mixlayerApiKey: env.MIXLAYER_API_KEY,
    mixlayerBaseUrl: env.MIXLAYER_BASE_URL,
    mixlayerModel: env.MIXLAYER_MODEL,
  });
}
