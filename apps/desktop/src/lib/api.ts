import { STORAGE_PREFIX } from "brand";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8787/v1";

function token(): string | null {
  return localStorage.getItem(`${STORAGE_PREFIX}_token`);
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;

  // Convert BigInt in body safely
  if (init.body && typeof init.body === "string") {
    // already serialized
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `request failed ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  auth: (email: string, displayName?: string) =>
    req<{ token: string; user: { id: string; email: string }; workspaceId: string }>("/auth/session", {
      method: "POST",
      body: JSON.stringify({ email, displayName }),
    }),
  me: () => req<{ valid: boolean; userId?: string }>("/auth/verify?token=" + encodeURIComponent(token() ?? "")),
  listWorkspaces: () => req<{ id: string; name: string; role: string }[]>("/workspaces"),
  listSessions: (workspaceId: string) =>
    req<{ id: string; title: string | null; status: string; consentStatus: string }[]>(
      `/interview-sessions?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  createSession: (body: Record<string, unknown>) =>
    req<{ id: string }>("/interview-sessions", { method: "POST", body: JSON.stringify(body) }),
  patchSession: (id: string, body: Record<string, unknown>) =>
    req(`/interview-sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  sessionAction: (id: string, action: "start" | "pause" | "complete") =>
    req(`/interview-sessions/${id}/${action}`, { method: "POST" }),
  deleteSession: (id: string) => req(`/interview-sessions/${id}`, { method: "DELETE" }),
  transcript: (id: string) => req<{ id: string; text: string; sequenceNo: number }[]>(`/interview-sessions/${id}/transcript`),
  insights: (id: string) => req<{ id: string; type: string; contentJson: Record<string, unknown> }[]>(`/interview-sessions/${id}/insights`),
  exportSession: (id: string) => req<Record<string, unknown>>(`/interview-sessions/${id}/export`, { method: "POST" }),
  visionSolve: (body: { sessionId?: string; prompt: string; images: { base64: string; mimeType: string }[] }) =>
    req<{ ok: boolean; text: string }>("/ai/vision", { method: "POST", body: JSON.stringify(body) }),
  sttSession: (workspaceId: string) =>
    req<{ session_token: string; relay_ws_url: string }>("/stt/session", {
      method: "POST",
      body: JSON.stringify({ workspaceId, channel: "direct" }),
    }),
  providerConnections: (workspaceId: string) =>
    req<{ id: string; provider: string; hasSecret: boolean }[]>(
      `/provider-connections?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  connectProvider: (body: { workspaceId: string; provider: string; secret: string }) =>
    req("/provider-connections", { method: "POST", body: JSON.stringify(body) }),
  modelProfiles: (workspaceId: string) =>
    req<{ id: string; name: string; taskClass: string; primaryModel: unknown; fallbackModels: unknown[] }[]>(
      `/model-profiles?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  testModelProfile: (id: string) => req<{ ok: boolean; latencyMs?: number }>(`/model-profiles/${id}/test`, { method: "POST" }),
  health: () => req<{ ok: boolean; version?: string }>("/health"),
  wsUrl: (sessionId: string) =>
    `${API_BASE.replace(/^http/, "ws")}/realtime?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token() ?? "")}`,
};

export { API_BASE };
