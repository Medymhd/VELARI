/**
 * Integration Hub — Google Calendar API (OAuth vault, client-authorized).
 * OAuth tokens stored as sealed `provider_connections.secret_ref`.
 * Least-privilege: calendar.readonly for reads, calendar.events for writes.
 */

const CAL_API = "https://www.googleapis.com/calendar/v3";

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  attendees: string[];
}

async function calFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${CAL_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Calendar API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export async function listUpcoming(accessToken: string, maxResults = 10): Promise<CalendarEvent[]> {
  const now = new Date().toISOString();
  const data = await calFetch<{
    items?: {
      id: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      attendees?: { email?: string }[];
    }[];
  }>(accessToken, `/users/me/events?timeMin=${now}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`);
  return (data.items ?? []).map((e) => ({
    id: e.id ?? "",
    title: e.summary ?? "Untitled",
    startsAt: e.start?.dateTime ?? e.start?.date ?? "",
    attendees: (e.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
  }));
}

export async function createCalendarEvent(
  accessToken: string,
  event: { title: string; startsAt: string; attendees: string[] },
): Promise<{ eventId: string }> {
  const res = await fetch(`${CAL_API}/users/me/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      summary: event.title,
      start: { dateTime: event.startsAt },
      end: { dateTime: new Date(new Date(event.startsAt).getTime() + 3600_000).toISOString() },
      attendees: event.attendees.map((email) => ({ email })),
    }),
  });
  if (!res.ok) throw new Error(`Calendar create ${res.status}`);
  const body = (await res.json()) as { id: string };
  return { eventId: body.id };
}

export async function handleCalendarWebhook(payload: unknown, signature?: string): Promise<void> {
  // Verify webhook HMAC before processing — prevents spoofed scheduling events.
  if (!signature) throw new Error("missing webhook signature");
  const expected = process.env.CALENDAR_WEBHOOK_SECRET;
  if (!expected) throw new Error("CALENDAR_WEBHOOK_SECRET not configured");
  const { createHmac } = await import("node:crypto");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const computed = createHmac("sha256", expected).update(body).digest("hex");
  if (computed !== signature) throw new Error("webhook signature mismatch");
}
