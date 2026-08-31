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

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new Error(
      `Cannot reach the API at ${API_BASE}. Make sure the backend is running (pnpm dev:api) and Postgres is up, then try again.`,
    );
  }
  if (res.status === 401) {
    window.dispatchEvent(new Event("app:unauthorized"));
    throw new Error("Session expired — sign in again");
  }
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
    req<
      {
        id: string;
        provider: string;
        hasSecret: boolean;
        metadataJson?: { baseUrl?: string; modelId?: string; fallbackModelIds?: string[] };
      }[]
    >(`/provider-connections?workspaceId=${encodeURIComponent(workspaceId)}`),
  connectProvider: (body: {
    workspaceId: string;
    provider: string;
    secret: string;
    baseUrl?: string;
    modelId?: string;
  }) => req("/provider-connections", { method: "POST", body: JSON.stringify(body) }),
  providerModels: (body: { connectionId?: string; baseUrl?: string; secret?: string }) =>
    req<{ models: { id: string; name?: string; contextWindow?: number; features?: string[] }[] }>(
      "/provider-connections/models",
      { method: "POST", body: JSON.stringify(body) },
    ),
  testProviderConnection: (id: string) =>
    req<{ ok: boolean; latencyMs: number; model?: string; error?: string }>(
      `/provider-connections/${id}/test`,
      { method: "POST" },
    ),
  saveModelProfile: (
    workspaceId: string,
    p: {
      id: string;
      name: string;
      taskClass: string;
      primaryModel: Record<string, unknown>;
      fallbackModels: Record<string, unknown>[];
    },
  ) => req(`/model-profiles/${p.id}`, { method: "PUT", body: JSON.stringify({ workspaceId, ...p }) }),
  modelProfiles: (workspaceId: string) =>
    req<{ id: string; name: string; taskClass: string; primaryModel: unknown; fallbackModels: unknown[] }[]>(
      `/model-profiles?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  updateModelProfile: (id: string, body: Record<string, unknown>) =>
    req(`/model-profiles/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  testModelProfile: (id: string) => req<{ ok: boolean; latencyMs?: number }>(`/model-profiles/${id}/test`, { method: "POST" }),
  policy: (workspaceId: string) => req<Record<string, unknown>>(`/workspaces/${workspaceId}/policy`),
  updatePolicy: (workspaceId: string, policy: Record<string, unknown>) =>
    req(`/workspaces/${workspaceId}/policy`, { method: "PATCH", body: JSON.stringify(policy) }),
  deleteProvider: (id: string) => req(`/provider-connections/${id}`, { method: "DELETE" }),
  health: () => req<{ ok: boolean; version?: string }>("/health"),
  verticalGet: <T>(vertical: string, path: string) => req<T>(`/verticals/${vertical}${path}`),
  verticalPost: <T>(vertical: string, path: string, body: unknown) =>
    req<T>(`/verticals/${vertical}${path}`, { method: "POST", body: JSON.stringify(body) }),
  wsUrl: (sessionId: string) =>
    `${API_BASE.replace(/^http/, "ws")}/realtime?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token() ?? "")}`,
};

export { API_BASE };
