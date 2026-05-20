export interface TelnyxClient {
  answerCall(input: {
    callControlId: string;
    commandId: string;
  }): Promise<void>;
  createConference(input: {
    callControlId: string;
    conferenceName: string;
    commandId: string;
  }): Promise<{ conferenceId: string | null }>;
  joinConference(input: {
    conferenceId: string;
    callControlId: string;
    commandId: string;
  }): Promise<void>;
  startStreaming(input: {
    callControlId: string;
    streamUrl: string;
    commandId: string;
  }): Promise<void>;
}

export class TelnyxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "TelnyxApiError";
  }
}

export class HttpTelnyxClient implements TelnyxClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.telnyx.com/v2",
  ) {}

  async answerCall(input: {
    callControlId: string;
    commandId: string;
  }): Promise<void> {
    await this.post(
      `/calls/${encodeURIComponent(input.callControlId)}/actions/answer`,
      {
        command_id: input.commandId,
      },
    );
  }

  async createConference(input: {
    callControlId: string;
    conferenceName: string;
    commandId: string;
  }): Promise<{ conferenceId: string | null }> {
    const response = await this.post("/conferences", {
      call_control_id: input.callControlId,
      command_id: input.commandId,
      name: input.conferenceName,
      beep_enabled: "never",
    });

    return {
      conferenceId: extractConferenceId(response),
    };
  }

  async joinConference(input: {
    conferenceId: string;
    callControlId: string;
    commandId: string;
  }): Promise<void> {
    await this.post(`/conferences/${input.conferenceId}/actions/join`, {
      call_control_id: input.callControlId,
      command_id: input.commandId,
      start_conference_on_enter: true,
    });
  }

  async startStreaming(input: {
    callControlId: string;
    streamUrl: string;
    commandId: string;
  }): Promise<void> {
    await this.post(
      `/calls/${encodeURIComponent(input.callControlId)}/actions/streaming_start`,
      {
        command_id: input.commandId,
        stream_url: input.streamUrl,
        stream_track: "both_tracks",
        stream_codec: "PCMU",
      },
    );
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      throw new TelnyxApiError(
        `Telnyx API request failed: ${response.status}`,
        response.status,
        responseBody,
      );
    }

    return responseBody;
  }
}

function extractConferenceId(response: unknown): string | null {
  if (!response || typeof response !== "object" || !("data" in response)) {
    return null;
  }

  const data = (response as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("id" in data)) {
    return null;
  }

  const id = (data as { id: unknown }).id;
  return typeof id === "string" ? id : null;
}
