export interface OutboundMessage {
  type: "message";
  channel: string;
  chatId: string;
  content: string;
  media: string[];
  replyTo: string | null;
  metadata: Record<string, unknown>;
}

export interface PairResponse {
  token: string;
  deviceId: string;
}

export interface MeResponse {
  deviceId: string;
  deviceName: string;
  version: string;
}

/** A paired dashboard device (spec 128 §A). Never carries token_hash/key_fingerprint. */
export interface DeviceInfo {
  id: string;
  name: string;
  shortId: string;
  createdAt: number | null;
  lastSeen: number | null;
  notificationsEnabled: boolean | null;
  /** True for the device making the request. */
  current: boolean;
}

export interface DevicesResponse {
  devices: DeviceInfo[];
}

export interface SessionInfo {
  key: string;
  /** Archive file name (job 132 §C). Present only for ARCHIVED sessions — the
   *  stable per-file identity, needed because one key can have many archives
   *  (one per `/new`). */
  id?: string;
  created_at?: string;
  updated_at?: string;
  path?: string;
  topic?: string | null;
  channel?: string;
  topic_user_set?: boolean;
  /** First user message, trimmed — powers the archive browser's list rows. */
  preview?: string | null;
  /** Number of messages in the session. */
  messageCount?: number;
}

export interface SessionMessage {
  role: string;
  content: string;
  timestamp?: string;
  name?: string;
  /** Attachments persisted with this message (assistant voice replies etc.). */
  media?: string[];
  /** The turn this message belongs to, when known. */
  turn_id?: string;
}

/** Authoritative per-session turn block (spec 127 §A). */
export interface TurnBlock {
  active: boolean;
  state: "idle" | "thinking" | "streaming" | "tool" | string;
  turn_id: string | null;
  started_at: number | null;
}

export interface SessionDetail {
  key: string;
  createdAt: string;
  messages: SessionMessage[];
  /** Additive live turn state (spec 127 §A.5); absent on older gateways. */
  turn?: TurnBlock;
}

/**
 * One archived transcript (job 132 §A). Same shape as `SessionDetail` plus the
 * archive's own identity, so the browser can address it by `id`.
 *
 * `messages` is server-filtered to user turns and assistant turns that have
 * text: no tool rows, no empty bubbles.
 */
export interface SessionArchiveDetail {
  /** Archive file name — the addressable identity. */
  id: string;
  key: string;
  channel: string;
  createdAt: string | null;
  updatedAt?: string | null;
  messages: SessionMessage[];
}

export interface FileNode {
  name: string;
  type: "file" | "dir";
  path: string;
  size?: number;
  children?: FileNode[];
}

export interface WorkspaceTree {
  root: string;
  tree: FileNode[];
}

export interface StatusResponse {
  version: string;
  gateway: { running: boolean; pid: number | null; log_file?: string | null };
  model: string;
  provider: string;
  workspace: string;
  channels: string[];
  dashboard: {
    host: string;
    port: number;
    streaming: boolean;
    pairingKeyCount: number;
  };
}

export interface ConfigResponse {
  [key: string]: unknown;
}

export interface ProviderInfo {
  name: string;
  label: string;
  kind: string;
  apiBase: string | null;
  hasApiKey: boolean;
  isLocal: boolean;
  active: boolean;
  role: string;
  roles: string[];
  model: string;
}

export type ModalityRole = "main" | "local" | "image";

export interface ModalityBinding {
  provider: string | null;
  model: string | null;
}

export interface ModalitiesResponse {
  main: ModalityBinding;
  local: ModalityBinding;
  image: ModalityBinding;
  active: string;
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  active: string;
}

export interface ProviderModelsResponse {
  provider: string;
  models: string[];
}

export interface RoleStatusResponse {
  main: string;
  main_model: string | null;
  local: string | null;
  local_model: string | null;
  image: string | null;
  image_model: string | null;
  active: string;
}

export interface RuntimeSetResponse {
  ok: boolean;
  applied: boolean;
  error?: string;
}

export interface UsageSummary {
  available: boolean;
  window_days: number;
  /** Active per-model filter (null/absent => all models). */
  model?: string | null;
  totals: {
    requests: number;
    prompt_tokens: number;
    cached_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_hit_pct: number;
  };
  by_model: Array<{
    model: string;
    provider: string;
    requests: number;
    prompt_tokens: number;
    cached_tokens: number;
    completion_tokens: number;
    cache_hit_pct: number;
  }>;
  timeseries: Array<{
    ts: string;
    prompt_tokens: number;
    cached_tokens: number;
    completion_tokens: number;
    cache_hit_pct: number;
  }>;
}

export interface JobMeta {
  [key: string]: unknown;
}

export interface JobEvent {
  id: number;
  ts: string;
  event_type: string;
  level: string;
  message: string;
  payload: Record<string, unknown> | null;
}

export interface Job {
  id: number;
  kind: string;
  title: string;
  status: string;
  repo: string | null;
  model: string | null;
  spec_path: string | null;
  result_path: string | null;
  meta: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  event_count: number;
  /**
   * True when the job claims to be running but has had no heartbeat for
   * JOB_STALE_MINUTES. The UI shows STALLED rather than claiming "running".
   */
  stalled?: boolean;
  last_event: {
    ts: string;
    event_type: string;
    level: string;
    message: string;
  } | null;
}

export interface JobsListResponse {
  jobs: Job[];
}

export interface JobDetailResponse {
  job: Job;
  events: JobEvent[];
  spec_text: string | null;
  result_text: string | null;
}
/**
 * Footer parity data (spec section D).
 *
 * Mirrors what `format_usage_footer` renders for Telegram (tokens, tokens/sec,
 * cost) and adds topic + context usage, which the dashboard shows natively.
 * Every field is nullable: telemetry failures degrade one field, never the strip.
 */
export interface SessionFooter {
  sessionKey: string;
  tokens: number;
  tokensPerSec: number;
  cost: number | null;
  topic: string | null;
  contextUsedTokens: number | null;
  contextLength: number | null;
  contextPct: number | null;
  model: string | null;
  provider: string | null;
  messageCount: number;
}
