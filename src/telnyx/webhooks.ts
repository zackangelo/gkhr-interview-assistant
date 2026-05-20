import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

const telnyxWebhookSchema = z.object({
  data: z.object({
    event_type: z.string(),
    id: z.string(),
    occurred_at: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
    record_type: z.string().optional(),
  }),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type TelnyxWebhookEvent = z.infer<typeof telnyxWebhookSchema>;

export function parseTelnyxWebhookEvent(
  input: unknown,
): TelnyxWebhookEvent | null {
  const result = telnyxWebhookSchema.safeParse(input);
  return result.success ? result.data : null;
}

export function verifyTelnyxWebhookSignature(input: {
  rawBody: string;
  publicKey: string;
  signature: string | null;
  timestamp: string | null;
}): boolean {
  if (!input.signature || !input.timestamp) {
    return false;
  }

  const publicKey = createEd25519PublicKey(input.publicKey);
  const signedPayload = Buffer.from(`${input.timestamp}|${input.rawBody}`);
  const signature = Buffer.from(input.signature, "base64");

  return verify(null, signedPayload, publicKey, signature);
}

function createEd25519PublicKey(publicKey: string) {
  if (publicKey.includes("BEGIN PUBLIC KEY")) {
    return createPublicKey(publicKey);
  }

  const rawKey = Buffer.from(publicKey, "base64");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, rawKey]),
    format: "der",
    type: "spki",
  });
}
