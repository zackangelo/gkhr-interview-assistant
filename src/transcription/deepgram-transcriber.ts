import { DeepgramClient } from "@deepgram/sdk";

import type {
  CreateTranscriptionSessionInput,
  StreamingTranscriber,
  TranscriptionResult,
  TranscriptionSession,
} from "./transcriber.js";

interface DeepgramTranscriberOptions {
  apiKey: string;
  model: string;
}

type DeepgramSocket = {
  on(event: "message", callback: (message: unknown) => void): void;
  on(event: "error", callback: (error: Error) => void): void;
  on(event: "close", callback: () => void): void;
  connect(): DeepgramSocket;
  waitForOpen(): Promise<unknown>;
  sendMedia(message: ArrayBufferView): void;
  close(): void;
};

interface DeepgramResultMessage {
  type: "Results";
  start: number;
  duration: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel: {
    alternatives: Array<{
      transcript: string;
      confidence: number;
      words: Array<{
        start: number;
        end: number;
        confidence: number;
        speaker?: number;
      }>;
    }>;
  };
}

export class DeepgramStreamingTranscriber implements StreamingTranscriber {
  private readonly client: DeepgramClient;

  constructor(private readonly options: DeepgramTranscriberOptions) {
    this.client = new DeepgramClient({ apiKey: options.apiKey });
  }

  createSession(input: CreateTranscriptionSessionInput): TranscriptionSession {
    return new DeepgramTranscriptionSession(this.client, this.options, input);
  }
}

class DeepgramTranscriptionSession implements TranscriptionSession {
  private connection: DeepgramSocket | null = null;

  constructor(
    private readonly client: DeepgramClient,
    private readonly options: DeepgramTranscriberOptions,
    private readonly input: CreateTranscriptionSessionInput,
  ) {}

  async start(): Promise<void> {
    const connection = (await this.client.listen.v1.connect({
      Authorization: `Token ${this.options.apiKey}`,
      model: this.options.model,
      encoding: this.input.encoding,
      sample_rate: this.input.sampleRate,
      channels: 1,
      diarize: "true",
      endpointing: 300,
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      tag: [`call:${this.input.callId}`, `track:${this.input.track}`],
    })) as DeepgramSocket;

    connection.on("message", (message) => {
      void this.handleMessage(message);
    });
    connection.on("error", (error) => {
      void this.input.onError(error);
    });

    this.connection = connection.connect();
    await this.connection.waitForOpen();
  }

  sendAudio(audio: Buffer): void {
    this.connection?.sendMedia(audio);
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isDeepgramResultMessage(message)) {
      return;
    }

    const alternative = message.channel.alternatives[0];
    const text = alternative?.transcript?.trim();
    if (!alternative || !text) {
      return;
    }

    const result: TranscriptionResult = {
      text,
      isFinal: message.is_final === true || message.speech_final === true,
      startedAtMs: toMilliseconds(getStartSeconds(message, alternative)),
      endedAtMs: toMilliseconds(getEndSeconds(message, alternative)),
      confidence: alternative.confidence,
      providerSpeakerLabel: getSpeakerLabel(alternative.words),
    };

    await this.input.onTranscript(result);
  }
}

function isDeepgramResultMessage(
  message: unknown,
): message is DeepgramResultMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "Results" &&
    "channel" in message
  );
}

function getSpeakerLabel(
  words: DeepgramResultMessage["channel"]["alternatives"][number]["words"],
): string | undefined {
  const speaker = words.find(
    (word) => typeof word.speaker === "number",
  )?.speaker;
  return typeof speaker === "number" ? `speaker_${speaker}` : undefined;
}

function getStartSeconds(
  message: DeepgramResultMessage,
  alternative: DeepgramResultMessage["channel"]["alternatives"][number],
): number {
  return alternative.words[0]?.start ?? message.start;
}

function getEndSeconds(
  message: DeepgramResultMessage,
  alternative: DeepgramResultMessage["channel"]["alternatives"][number],
): number {
  return (
    alternative.words[alternative.words.length - 1]?.end ??
    message.start + message.duration
  );
}

function toMilliseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}
