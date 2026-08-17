export interface OutboundMessage {
  type: "message";
  channel: string;
  chatId: string;
  content: string;
  media: string[];
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