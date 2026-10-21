/**
 * The Ask mode reducer — the ONE place frame → state lives.
 *
 * Both SPAs (desktop `views/AskView.tsx` and mobile `mobile/AskView.tsx`)
 * import this module, so the two surfaces cannot drift apart. That is the same
 * rule the chat transcript follows (`lib/transcript.ts`): shared frame
 * behaviour lives in one module, never duplicated inline (HARD LESSON 20/22).
 *
 * The backend contract is documented in
 * `uttaram-backend/docs/API.md`:
 *
 *   {"type":"init"}
 *   {"type":"phase","data":{"phase":"classifying"|"researching"|"writing"}}
 *   {"type":"step","data":{"kind":"searching","queries":[…]}}
 *   {"type":"step","data":{"kind":"reading","url","title"}}
 *   {"type":"sources","data":[{idx,title,url,domain}]}
 *   {"type":"response","data":"<delta text>"}
 *   {"type":"usage","data":{tokensIn,tokensOut,iterations,latencyMs,sources}}
 *   {"type":"done"}
 *   {"type":"error","data":{"message","code"}}
 */
import { useCallback, useRef, useState } from "react";

export type AskMode = "speed" | "balanced" | "quality";

/** The source toggles. The names are the backend's `SearchSources`. */
export type AskSourceKind = "web" | "discussions" | "academic";

export type AskPhase = "idle" | "classifying" | "researching" | "writing" | "done" | "error";

export interface AskSource {
  idx: number;
  title: string;
  url: string;
  domain: string;
}

export type AskStep =
  | { kind: "searching"; queries: string[] }
  | { kind: "reading"; url: string; title: string };

export interface AskUsage {
  tokensIn: number;
  tokensOut: number;
  iterations: number;
  latencyMs: number;
  sources: number;
}

export interface AskError {
  message: string;
  code: string;
}

/**
 * One media item of the answer's media strip.
 *
 * The frozen backend contract has no media frame yet, so the strip stays
 * empty today — the frame is handled anyway so a backend that grows one does
 * not need a dashboard change.
 */
export interface AskMedia {
  kind: "image" | "video";
  url: string;
  thumb?: string;
  title?: string;
}

export interface AskState {
  /** The phase line under the query box. */
  phase: AskPhase;
  /** The answer text, concatenated from the `response` deltas. */
  answer: string;
  /** The cited sources, in citation order. */
  sources: AskSource[];
  /** The research steps, in the order they happened. */
  steps: AskStep[];
  /** The media strip. */
  media: AskMedia[];
  /** The terminal counters. `null` until the `usage` frame arrives. */
  usage: AskUsage | null;
  /** The terminal error, if the stream failed. */
  error: AskError | null;
  /** True while the stream is open. */
  streaming: boolean;
}

export const initialAskState: AskState = {
  phase: "idle",
  answer: "",
  sources: [],
  steps: [],
  media: [],
  usage: null,
  error: null,
  streaming: false,
};

/** The modes, in the order the UI shows them. */
export const ASK_MODES: { id: AskMode; label: string; hint: string }[] = [
  { id: "speed", label: "Speed", hint: "2 iterations · one search" },
  { id: "balanced", label: "Balanced", hint: "6 iterations" },
  { id: "quality", label: "Deep", hint: "25 iterations · reads the pages" },
];

/** The source toggles, in the order the UI shows them. */
export const ASK_SOURCE_KINDS: { id: AskSourceKind; label: string }[] = [
  { id: "web", label: "Web" },
  { id: "discussions", label: "Discussions" },
  { id: "academic", label: "Academic" },
];

/** One frame as it arrives on the wire. */
export interface AskFrame {
  type: string;
  data?: any;
}

const PHASES: AskPhase[] = ["classifying", "researching", "writing"];

const isPhase = (value: unknown): value is AskPhase =>
  typeof value === "string" && (PHASES as string[]).includes(value);

const isSource = (value: any): value is AskSource =>
  Boolean(value) && typeof value.url === "string" && value.url.length > 0;

/**
 * Fold one frame into the state. Pure — it returns a new state object.
 *
 * Every frame type is handled: `init`, `phase`, `step`, `sources`,
 * `response`, `usage`, `done` and `error`. An unknown frame leaves the state
 * untouched (a newer backend must not break an older dashboard).
 */
export function reduceAskFrame(state: AskState, frame: AskFrame): AskState {
  if (!frame || typeof frame.type !== "string") return state;

  switch (frame.type) {
    case "init":
      return { ...state, phase: "idle", streaming: true, error: null };

    case "phase":
      if (!isPhase(frame.data?.phase)) return state;
      return { ...state, phase: frame.data.phase };

    case "step": {
      const step = frame.data as AskStep | undefined;
      if (!step || typeof step !== "object") return state;
      if (step.kind === "searching") {
        const queries = Array.isArray(step.queries) ? step.queries : [];
        return { ...state, steps: [...state.steps, { kind: "searching", queries }] };
      }
      if (step.kind === "reading" && typeof step.url === "string") {
        return {
          ...state,
          steps: [
            ...state.steps,
            { kind: "reading", url: step.url, title: step.title || step.url },
          ],
        };
      }
      return state;
    }

    case "sources": {
      const list = Array.isArray(frame.data) ? frame.data : [];
      const sources = list.filter(isSource).map((source, index) => ({
        idx: typeof source.idx === "number" ? source.idx : index + 1,
        title: source.title || source.url,
        url: source.url,
        domain: source.domain || "",
      }));
      return { ...state, sources };
    }

    case "media": {
      const list = Array.isArray(frame.data) ? frame.data : [];
      const media = list
        .filter((item: any) => item && typeof item.url === "string" && item.url)
        .map((item: any) => ({
          kind: item.kind === "video" ? ("video" as const) : ("image" as const),
          url: item.url,
          thumb: item.thumb,
          title: item.title,
        }));
      return { ...state, media };
    }

    case "response":
      if (typeof frame.data !== "string") return state;
      return { ...state, answer: state.answer + frame.data };

    case "usage": {
      const usage = frame.data as Partial<AskUsage> | undefined;
      if (!usage || typeof usage !== "object") return state;
      return {
        ...state,
        usage: {
          tokensIn: Number(usage.tokensIn) || 0,
          tokensOut: Number(usage.tokensOut) || 0,
          iterations: Number(usage.iterations) || 0,
          latencyMs: Number(usage.latencyMs) || 0,
          sources: Number(usage.sources) || 0,
        },
      };
    }

    case "done":
      return { ...state, phase: "done", streaming: false };

    case "error": {
      const error = (frame.data || {}) as Partial<AskError>;
      return {
        ...state,
        phase: "error",
        streaming: false,
        error: {
          message: error.message || "The search failed",
          code: error.code || "search_failed",
        },
      };
    }

    default:
      return state;
  }
}

/** The human label of the phase line. */
export function phaseLabel(phase: AskPhase): string {
  switch (phase) {
    case "classifying":
      return "Thinking about what to look for…";
    case "researching":
      return "Researching…";
    case "writing":
      return "Writing the answer…";
    case "done":
      return "Done";
    case "error":
      return "Failed";
    default:
      return "";
  }
}

/** `4.2 s · 6 iterations · 12 sources` — the usage footer. */
export function formatAskUsage(usage: AskUsage | null): string {
  if (!usage) return "";
  const parts: string[] = [];
  const seconds = usage.latencyMs / 1000;
  parts.push(`${seconds.toFixed(1)} s`);
  parts.push(`${usage.iterations} ${usage.iterations === 1 ? "iteration" : "iterations"}`);
  parts.push(`${usage.sources} ${usage.sources === 1 ? "source" : "sources"}`);
  const tokens = usage.tokensIn + usage.tokensOut;
  if (tokens > 0) parts.push(`${(tokens / 1000).toFixed(1)}k tokens`);
  return parts.join(" · ");
}

/** One line per research step, for the collapsible list. */
export function describeAskStep(step: AskStep): string {
  if (step.kind === "searching") {
    const queries = step.queries || [];
    if (queries.length === 0) return "searching";
    if (queries.length === 1) return `searching “${queries[0]}”`;
    return `searching ${queries.length} queries`;
  }
  const host = step.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `reading ${host}`;
}

/**
 * Split the answer into text and `[n]` citation markers.
 *
 * The writer cites with `[1]`, `[2][3]` — the markers are what turn the
 * answer into a linked document, so they are rendered as anchors to the
 * matching source.
 */
export function splitAnswerCitations(
  answer: string,
): Array<{ type: "text" | "citation"; value: string; index?: number }> {
  const out: Array<{ type: "text" | "citation"; value: string; index?: number }> = [];
  const pattern = /\[(\d{1,2})\]/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(answer)) !== null) {
    if (match.index > last) {
      out.push({ type: "text", value: answer.slice(last, match.index) });
    }
    out.push({ type: "citation", value: match[0], index: Number(match[1]) });
    last = match.index + match[0].length;
  }

  if (last < answer.length) {
    out.push({ type: "text", value: answer.slice(last) });
  }

  return out;
}

/** The source a citation points at, if the backend sent it. */
export function sourceForCitation(
  sources: AskSource[],
  index: number | undefined,
): AskSource | undefined {
  if (!index) return undefined;
  return sources.find((source) => source.idx === index);
}

// ---------------------------------------------------------------------------
// History (localStorage — no server-side history in this job)
// ---------------------------------------------------------------------------

export const ASK_HISTORY_KEY = "sarathy.ask.history";
export const ASK_HISTORY_LIMIT = 50;

export interface AskHistoryEntry {
  id: string;
  query: string;
  mode: AskMode;
  sources: AskSourceKind[];
  answer: string;
  createdAt: number;
}

/** Read the history rail, newest first. Never throws. */
export function loadAskHistory(): AskHistoryEntry[] {
  try {
    const raw = localStorage.getItem(ASK_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.query === "string")
      .slice(0, ASK_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Persist the history rail, capped at 50 entries. Never throws. */
export function saveAskHistory(entries: AskHistoryEntry[]): AskHistoryEntry[] {
  const capped = entries.slice(0, ASK_HISTORY_LIMIT);
  try {
    localStorage.setItem(ASK_HISTORY_KEY, JSON.stringify(capped));
  } catch {
    /* storage full or blocked — the rail is a convenience, not a requirement */
  }
  return capped;
}

/** Prepend a finished turn to the history rail. */
export function pushAskHistory(
  entries: AskHistoryEntry[],
  entry: AskHistoryEntry,
): AskHistoryEntry[] {
  return saveAskHistory([entry, ...entries.filter((e) => e.id !== entry.id)]);
}

// ---------------------------------------------------------------------------
// Transport — the NDJSON client and the hook both shells share
// ---------------------------------------------------------------------------

/**
 * The dashboard's auth token.
 *
 * Read straight from `localStorage` rather than through `@/lib/api`: this
 * module is imported by the Ask views, which the App imports, and the API
 * module is mocked in a dozen test files — a hard dependency on it would make
 * the Ask surface impossible to load in isolation. `sarathy_token` is the
 * same key `lib/api.ts` uses.
 */
export const ASK_TOKEN_KEY = "sarathy_token";

export function askAuthToken(): string {
  try {
    return localStorage.getItem(ASK_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** Split a raw NDJSON buffer into the frames it holds. */
export function parseAskFrames(buffer: string): { frames: AskFrame[]; rest: string } {
  const frames: AskFrame[] = [];
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      frames.push(JSON.parse(trimmed) as AskFrame);
    } catch {
      /* a partial or malformed line is not a frame */
    }
  }

  return { frames, rest };
}

export interface AskRunRequest {
  query: string;
  mode: AskMode;
  sources: AskSourceKind[];
  /** The chat session this turn belongs to. */
  sessionKey?: string;
}

/**
 * The Ask session — the hook both shells use.
 *
 * It owns the transport (POST /api/ask, read the NDJSON stream, fold every
 * frame through `reduceAskFrame`), the Stop button's abort, and the history
 * rail. Both the desktop and the mobile view call it, so the two behave
 * identically.
 */
export function useAskStream() {
  const [state, setState] = useState<AskState>(initialAskState);
  const [history, setHistory] = useState<AskHistoryEntry[]>(() => loadAskHistory());
  const abortRef = useRef<AbortController | null>(null);

  const dispatch = useCallback((frame: AskFrame) => {
    setState((prev) => reduceAskFrame(prev, frame));
  }, []);

  const finish = useCallback(
    (query: string, request: AskRunRequest, answer: string) => {
      const entry: AskHistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        query,
        mode: request.mode,
        sources: request.sources,
        answer,
        createdAt: Date.now(),
      };
      setHistory((prev) => pushAskHistory(prev, entry));
    },
    [],
  );

  const run = useCallback(
    async (request: AskRunRequest) => {
      const query = request.query.trim();
      if (!query) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ ...initialAskState, streaming: true });

      let answer = "";

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        const token = askAuthToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        const response = await fetch("/api/ask", {
          method: "POST",
          headers,
          body: JSON.stringify({
            query,
            mode: request.mode,
            sources: request.sources,
            session_key: request.sessionKey,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let message = `The ask backend is unavailable (${response.status})`;
          try {
            const body = await response.json();
            if (body?.error?.message) message = String(body.error.message);
          } catch {
            /* keep the default message */
          }
          dispatch({ type: "error", data: { message, code: "backend_unavailable" } });
          return;
        }

        if (!response.body) {
          dispatch({
            type: "error",
            data: { message: "The ask backend sent no stream", code: "no_stream" },
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseAskFrames(buffer);
          buffer = rest;
          for (const frame of frames) {
            if (frame.type === "response" && typeof frame.data === "string") {
              answer += frame.data;
            }
            dispatch(frame);
            if (frame.type === "done") finish(query, request, answer);
          }
        }

        if (buffer.trim()) {
          const { frames } = parseAskFrames(`${buffer}\n`);
          for (const frame of frames) {
            if (frame.type === "response" && typeof frame.data === "string") {
              answer += frame.data;
            }
            dispatch(frame);
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          dispatch({ type: "done" });
          return;
        }
        dispatch({
          type: "error",
          data: {
            message: err instanceof Error ? err.message : "The ask failed",
            code: "ask_failed",
          },
        });
      } finally {
        abortRef.current = null;
      }
    },
    [dispatch, finish],
  );

  const stop = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = askAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      await fetch("/api/ask/stop", { method: "POST", headers, body: "{}" });
    } catch {
      /* the local abort already stopped the stream */
    }
    setState((prev) => ({ ...prev, streaming: false, phase: prev.phase === "error" ? "error" : "done" }));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(initialAskState);
  }, []);

  const reopen = useCallback((entry: AskHistoryEntry) => {
    setState({
      ...initialAskState,
      answer: entry.answer || "",
      sources: [],
      phase: "done",
    });
  }, []);

  const forget = useCallback((id: string) => {
    setHistory((prev) => saveAskHistory(prev.filter((entry) => entry.id !== id)));
  }, []);

  return { state, history, run, stop, reset, reopen, forget };
}
