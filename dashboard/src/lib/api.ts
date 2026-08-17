import type {
  ConfigResponse,
  MeResponse,
  PairResponse,
  SessionDetail,
  SessionInfo,
  StatusResponse,
  WorkspaceTree,
} from "./types";

const TOKEN_KEY = "sarathy_token";
let token = localStorage.getItem(TOKEN_KEY) || "";

export function getToken(): string {
  return token;
}

export function setToken(value: string): void {
  token = value;
  localStorage.setItem(TOKEN_KEY, value);
}

export function clearToken(): void {
  token = "";
  localStorage.removeItem(TOKEN_KEY);
}

export class AuthError extends Error {}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    throw new AuthError("unauthorized");
  }
  if (!res.ok) {
    let message = res.statusText || "Request failed";
    try {
      const body = await res.json();
      if (body?.error) message = String(body.error);
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  pair: (key: string, deviceName: string) =>
    request<PairResponse>("/api/auth/pair", {
      method: "POST",
      body: JSON.stringify({ key, deviceName }),
    }),

  me: () => request<MeResponse>("/api/auth/me"),

  logout: () =>
    request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }).catch(() => null),

  sendChat: (content: string) =>
    request<{ ok: boolean }>("/api/chat", { method: "POST", body: JSON.stringify({ content }) }),

  stopChat: () => request<{ ok: boolean }>("/api/chat/stop", { method: "POST" }),

  getConfig: () => request<ConfigResponse>("/api/config"),
  putConfig: (data: ConfigResponse) =>
    request<{ ok: boolean; restartRequired: boolean }>("/api/config", {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  restart: () => request<{ ok: boolean }>("/api/restart", { method: "POST" }),

  sessions: () => request<{ sessions: SessionInfo[] }>("/api/sessions"),

  session: (key: string) =>
    request<SessionDetail>(`/api/session?key=${encodeURIComponent(key)}`),

  workspaceTree: () => request<WorkspaceTree>("/api/workspace/tree"),

  readFile: (path: string) =>
    request<{ path: string; content: string }>(
      `/api/workspace/file?path=${encodeURIComponent(path)}`,
    ),

  writeFile: (path: string, content: string) =>
    request<{ ok: boolean }>("/api/workspace/file", {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),

  status: () => request<StatusResponse>("/api/status"),
};