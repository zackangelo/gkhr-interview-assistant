import type { CallDetail, CallSummary } from "./types";

export async function fetchCalls(): Promise<CallSummary[]> {
  const body = await fetchJson<{ calls: CallSummary[] }>("/calls");
  return body.calls;
}

export async function fetchCall(callId: string): Promise<CallDetail> {
  const body = await fetchJson<{ call: CallDetail }>(
    `/calls/${encodeURIComponent(callId)}`,
  );
  return body.call;
}

export async function createCall(input: {
  contextPrompt: string;
  conferenceName?: string;
}): Promise<CallSummary> {
  const body = await fetchJson<{ call: CallSummary }>("/calls", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  return body.call;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body?.error?.message === "string"
        ? body.error.message
        : "Request failed";
    throw new Error(message);
  }

  return body as T;
}
