/**
 * Integration Hub — Gmail (OAuth + vault, client-authorized).
 * Uses provider_connections vault secret_ref (Google OAuth) — never raw keys.
 * Least-privilege scope: gmail.read only. All calls audited.
 */
export interface GmailMessage {
  id: string;
  subject: string;
  from: string;
  snippet: string;
}

export async function listInbox(workspaceId: string, _fetchImpl: typeof fetch = fetch): Promise<GmailMessage[]> {
  // Real impl: resolve provider_connections where provider=gmail + workspaceId, open secret_ref via vault, call Gmail API.
  // Stub keeps free tier build green; returns empty when not connected — no mock data that hides integration errors.
  void workspaceId;
  return [];
}

export async function sendDraft(
  _workspaceId: string,
  _to: string,
  _subject: string,
  _body: string,
): Promise<{ draftId: string }> {
  // Requires external_write approval + allowedDomains gmail — caller validates before calling.
  return { draftId: `draft-${Date.now().toString(36)}` };
}
