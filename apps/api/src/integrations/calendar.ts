/** Integration Hub — Calendar (port of rival `CalendarManager.ts` stub). */
export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  attendees: string[];
}

export async function listUpcoming(_workspaceId: string): Promise<CalendarEvent[]> {
  // TODO: OAuth Google Calendar / Outlook via `googleServiceAccount.ts` pattern
  return [];
}

export async function handleCalendarWebhook(_payload: unknown): Promise<void> {
  // TODO: verify signature, upsert, trigger context prep
}
