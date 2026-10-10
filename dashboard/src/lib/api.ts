import type { Quote } from "./quotes";
import type { SlashCommand } from "./palette";
import type {
  ConfigResponse,
  JobDetailResponse,
  JobsListResponse,
  MeResponse,
  PairResponse,
  ProviderModelsResponse,
  ProvidersResponse,
  RoleStatusResponse,
  RuntimeSetResponse,
  SessionDetail,
  SessionFooter,
  SessionInfo,
  StatusResponse,
  UsageSummary,
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

  /**
   * Send a message, optionally with attachments, a reply target and
   * quote-and-ask selections. Quotes are wrapped server-side into a context
   * block above the user text so they persist in the transcript.
   */
  sendChatFull: (args: {
    content: string;
    media?: string[];
    replyTo?: string | null;
    quotes?: Quote[];
  }) =>
    request<{ ok: boolean }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        content: args.content,
        ...(args.media?.length ? { media: args.media } : {}),
        reply_to: args.replyTo ?? null,
        ...(args.quotes?.length ? { quotes: args.quotes } : {}),
      }),
    }),

  sendChatWithMedia: (content: string, media: string[], replyTo?: string | null) =>
    request<{ ok: boolean }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ content, media, reply_to: replyTo ?? null }),
    }),

  uploadMedia: async (file: File): Promise<{ ok: boolean; path: string; url: string }> => {
    const form = new FormData();
    form.append("file", file, file.name);
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch("/api/media", { method: "POST", headers, body: form });
    if (res.status === 401) throw new AuthError("unauthorized");
    if (!res.ok) {
      let message = res.statusText || "Upload failed";
      try {
        const body = await res.json();
        if (body?.error) message = String(body.error);
      } catch { /* ignore */ }
      throw new Error(message);
    }
    return res.json();
  },

  stopChat: () => request<{ ok: boolean }>("/api/chat/stop", { method: "POST" }),

  getConfig: () => request<ConfigResponse>("/api/config"),
  putConfig: (data: ConfigResponse) =>
    request<{ ok: boolean; restartRequired: boolean }>("/api/config", {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  providers: () => request<ProvidersResponse>("/api/providers"),

  providerModels: (name: string) =>
    request<ProviderModelsResponse>(`/api/providers/${encodeURIComponent(name)}/models`),

  addProvider: (data: Record<string, unknown>) =>
    request<{ ok: boolean }>("/api/providers", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  editProvider: (name: string, data: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  removeProvider: (name: string) =>
    request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(name)}`, { method: "DELETE" }),

  setProviderRole: (name: string, role: string, model?: string) =>
    request<RoleStatusResponse>(`/api/providers/${encodeURIComponent(name)}/role`, {
      method: "POST",
      body: JSON.stringify({ role, model }),
    }),

  setRuntime: (data: { provider?: string; model?: string }) =>
    request<RuntimeSetResponse>("/api/runtime", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  restart: () => request<{ ok: boolean }>("/api/restart", { method: "POST" }),

  sessions: () => request<{ sessions: SessionInfo[] }>("/api/sessions"),

  sessionNew: (key: string) =>
    request<{ ok: boolean }>("/api/session/new", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),

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

  usageSummary: (days = 7, model?: string | null) => {
    const params = new URLSearchParams({ days: String(days) });
    if (model) params.set("model", model);
    return request<UsageSummary>(`/api/usage/summary?${params.toString()}`);
  },

  jobs: () => request<JobsListResponse>("/api/jobs"),

  job: (id: number) => request<JobDetailResponse>(`/api/jobs/${id}`),

  /** Builtin slash commands, sourced from the backend registry. */
  commands: () => request<{ commands: SlashCommand[]; count: number }>("/api/commands"),

  /** Footer parity data (tokens, tps, cost, topic, context, model). */
  sessionFooter: (key?: string) =>
    request<SessionFooter>(
      `/api/session/footer${key ? `?key=${encodeURIComponent(key)}` : ""}`,
    ),

  /** Public VAPID key. Safe to expose; the private key never leaves the server. */
  pushKey: () => request<{ publicKey: string; available: boolean }>("/api/push/key"),

  pushSubscribe: (subscription: unknown) =>
    request<{ ok: boolean; count: number }>("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription }),
    }),

  /** Drop one stored push subscription by endpoint (best-effort). */
  pushUnsubscribe: (endpoint: string) =>
    request<{ ok: boolean; count?: number }>("/api/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    }),

  pushSend: (title: string, body: string) =>
    request<{ ok: boolean; delivered: number; failed: number; pruned: number }>(
      "/api/push/send",
      { method: "POST", body: JSON.stringify({ title, body }) },
    ),
};