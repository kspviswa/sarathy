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

export interface SessionInfo {
  key: string;
  created_at?: string;
  updated_at?: string;
  path?: string;
}

export interface SessionDetail {
  key: string;
  createdAt: string;
  messages: Array<{ role: string; content: string; timestamp?: string; name?: string }>;
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
/* ------------------------------------------------------------------ SC fleet
 * Types for the Sarathy Clients fleet view (design/SARATHY_CLIENTS_SPEC.md
 * section 9; job spec section H). The gateway's /api/sc/* responses.
 */

/** Health is derived from `last_seen` against the watchdog grace, not stored. */
export type ScHealth = "online" | "stale" | "offline";

export type ScNodeState =
  | "pending"
  | "pairing"
  | "online"
  | "offline"
  | "revoked";

/** Risk classes from spec section 6.1. `deny` is hard-coded and never allowlisted. */
export type ScRisk = "auto" | "ask" | "deny";

export interface ScCapability {
  name: string;
  version: string;
  kind: string;
  risk: ScRisk | string;
  state: string;
  scopes?: string[];
  title?: string;
  description?: string;
}

export interface ScGrant {
  id?: string;
  capability: string;
  mode: string;
  scope?: string | null;
  source?: string;
  expires?: string | null;
  revoked?: boolean;
}

export interface ScService {
  name: string;
  port: number;
  host?: string;
  type: string;
  registered?: boolean;
  running?: boolean;
  schema_uri?: string | null;
}

export interface ScNode {
  id: string;
  name: string;
  state: ScNodeState | string;
  health: ScHealth | string;
  last_seen: string | null;
  last_seen_age_s: number | null;
  paired: boolean;
  paired_at: string | null;
  revoked_at: string | null;
  platform: string;
  arch: string;
  version: string;
  capabilities_hash: string;
  capabilities: ScCapability[];
  capability_names: (string | null)[];
  risk_classes: string[];
  grants: ScGrant[];
  grant_count: number;
  services: ScService[];
  note: string;
  created_at: string;
}

export interface ScFleetSummary {
  total: number;
  online: number;
  stale: number;
  offline: number;
  revoked: number;
  watchdog_grace_s: number;
  capabilities: string[];
}

export interface ScNodesResponse {
  nodes: ScNode[];
  summary: ScFleetSummary;
  watchdog_grace_s: number;
}

export interface ScAddNodeRequest {
  node_id: string;
  name?: string;
  pairing_key?: string;
  generate_key?: boolean;
  note?: string;
}

export interface ScAddNodeResponse {
  node: ScNode;
  /** Present exactly once, when the gateway generated the key. Never recoverable. */
  pairing_key: string | null;
  pairing_key_generated: boolean;
  hint: string;
}

export interface ScRevokeResponse {
  ok: boolean;
  node: ScNode;
  session_closed: boolean;
  note: string;
}
