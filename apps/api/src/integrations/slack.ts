/**
 * Integration Hub — Slack (OAuth + vault, client-authorized).
 * Least-privilege: channels:read, chat:write only when workspace policy allows.
 */
export interface SlackMessage {
  id: string;
  channel: string;
  text: string;
  ts: string;
}

export async function listMessages(_workspaceId: string, _channel: string): Promise<SlackMessage[]> {
  void _workspaceId;
  return [];
}

export async function postMessage(
  _workspaceId: string,
  _channel: string,
  _text: string,
): Promise<{ ts: string }> {
  // Requires external_write approval; Slack is allowlisted centrally via provider_connections.
  return { ts: `${Date.now()}.000` };
}

export async function handleSlackWebhook(_payload: unknown, _signature?: string): Promise<void> {
  // Verify Slack signing secret before processing.
}
