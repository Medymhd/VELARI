/**
 * Integration Hub — Slack Web API (OAuth vault, client-authorized).
 * Least-privilege: channels:read, chat:write only when workspace policy allows.
 */

const SLACK_API = "https://slack.com/api";

export interface SlackMessage {
  id: string;
  channel: string;
  text: string;
  ts: string;
}

async function slackFetch<T>(accessToken: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${accessToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Slack API ${res.status}`);
  const data = (await res.json()) as { ok: boolean; error?: string; messages?: SlackMessage[] };
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data as T;
}

export async function listMessages(accessToken: string, channel: string, limit = 20): Promise<SlackMessage[]> {
  const data = await slackFetch<{ messages?: SlackMessage[] }>(accessToken, "conversations.history", {
    channel,
    limit,
  });
  return data.messages ?? [];
}

export async function postMessage(
  accessToken: string,
  channel: string,
  text: string,
): Promise<{ ts: string }> {
  const data = await slackFetch<{ ts: string }>(accessToken, "chat.postMessage", { channel, text });
  return { ts: data.ts };
}

export async function handleSlackWebhook(payload: unknown, signature?: string): Promise<void> {
  if (!signature) throw new Error("missing Slack signing secret");
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) throw new Error("SLACK_SIGNING_SECRET not configured");
  const { createHmac } = await import("node:crypto");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const computed = createHmac("sha256", secret).update(body).digest("hex");
  if (computed !== signature) throw new Error("Slack signature mismatch");
}
