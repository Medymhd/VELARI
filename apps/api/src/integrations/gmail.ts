/**
 * Integration Hub — Gmail via Google Gmail API (OAuth vault, client-authorized).
 * OAuth tokens are stored as `provider_connections.secret_ref` (sealed v1.*).
 * Resolved at call time via `services.openSecret`. Least-privilege: gmail.readonly.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

export interface GmailMessage {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  date: string;
}

async function gmailFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export async function listInbox(accessToken: string, maxResults = 10): Promise<GmailMessage[]> {
  const list = await gmailFetch<{ messages?: { id: string }[] }>(
    accessToken,
    `/users/me/messages?maxResults=${maxResults}&q=in:inbox`,
  );
  if (!list.messages) return [];
  const messages = await Promise.all(
    list.messages.slice(0, maxResults).map(async (m) => {
      const detail = await gmailFetch<{
        id: string;
        snippet: string;
        payload?: { headers?: { name: string; value: string }[] };
      }>(accessToken, `/users/me/messages/${m.id}`);
      const getHeader = (name: string) =>
        detail.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
      return {
        id: detail.id,
        subject: getHeader("Subject"),
        from: getHeader("From"),
        snippet: detail.snippet ?? "",
        date: getHeader("Date"),
      };
    }),
  );
  return messages;
}

export async function sendDraft(
  accessToken: string,
  to: string,
  subject: string,
  body: string,
): Promise<{ draftId: string }> {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
  const encoded = Buffer.from(raw).toString("base64url");
  const res = await fetch(`${GMAIL_API}/users/me/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      message: { raw: encoded },
    }),
  });
  if (!res.ok) throw new Error(`Gmail send draft ${res.status}`);
  const body2 = (await res.json()) as { id: string };
  return { draftId: body2.id };
}
