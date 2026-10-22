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
 *   {"type":"step","data":{"kind":"reasoning","reasoning":"…"}}
 *   {"type":"step","data":{"kind":"searching","queries":[…]}}
 *   {"type":"step","data":{"kind":"reading","url","title"}}
 *   {"type":"sources","data":[{idx,title,url,domain}]}
 *   {"type":"response","data":"<delta text>"}
 *   {"type":"usage","data":{tokensIn,tokensOut,iterations,latencyMs,sources}}
 *   {"type":"done"}
 *   {"type":"error","data":{"message","code"}}
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Quote } from "@/lib/quotes";

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

/**
 * One research step.
 *
 * `reasoning` is the researcher's plan preamble ("Thinking…"), `found` is
 * derived here — never on the wire — when the `sources` frame lands.
 * `timeout` / `retrying` / `gave_up` are defensive: the engine does not emit
 * them today, but the timeline knows how to draw them.
 */
export type AskStep =
  | { kind: "searching"; queries: string[] }
  | { kind: "reading"; url: string; title: string }
  | { kind: "reasoning"; reasoning: string }
  | { kind: "found"; count: number }
  | { kind: "timeout"; attempt: number; max: number }
  | { kind: "retrying"; attempt: number; max: number }
  | { kind: "gave_up"; message?: string };

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
 */
export interface AskMedia {
  kind: "image" | "video";
  url: string;
  thumb?: string;
  img_src?: string;
  title?: string;
  iframe_src?: string;
  iframeUrl?: string;
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

      if (step.kind === "reasoning") {
        const reasoning = typeof step.reasoning === "string" ? step.reasoning : "";
        // The engine re-sends the whole sub-step list on every block update.
        // A plan that GREW updates the step already on screen instead of
        // drawing a second "Thinking" row.
        const last = state.steps[state.steps.length - 1];
        if (last && last.kind === "reasoning" && reasoning.startsWith(last.reasoning)) {
          return {
            ...state,
            steps: [...state.steps.slice(0, -1), { kind: "reasoning", reasoning }],
          };
        }
        return { ...state, steps: [...state.steps, { kind: "reasoning", reasoning }] };
      }

      if (step.kind === "timeout" || step.kind === "retrying") {
        return {
          ...state,
          steps: [
            ...state.steps,
            {
              kind: step.kind,
              attempt: Number(step.attempt) || 1,
              max: Number(step.max) || 1,
            },
          ],
        };
      }

      if (step.kind === "gave_up") {
        return {
          ...state,
          steps: [...state.steps, { kind: "gave_up", message: step.message }],
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
      // The `found` step is DERIVED here — it is not a wire frame. It lands
      // after the research steps, where the timeline reads "Found N results".
      const steps = sources.length
        ? [...state.steps, { kind: "found" as const, count: sources.length }]
        : state.steps;
      return { ...state, sources, steps };
    }

    case "media": {
      const list = Array.isArray(frame.data) ? frame.data : [];
      const media = list
        .filter((item: any) => item && typeof item.url === "string" && item.url)
        .map((item: any) => ({
          kind: item.kind === "video" ? ("video" as const) : ("image" as const),
          url: item.url,
          thumb: item.thumb,
          img_src: item.img_src,
          title: item.title,
          iframe_src: item.iframe_src,
          iframeUrl: item.iframeUrl || item.iframe_src,
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

/**
 * The human label of the phase line — Uttaram's three words (spec §D.2).
 *
 * `Classifying query…` → `Brainstorming…` → `Generating answer…`
 */
export function phaseLabel(phase: AskPhase): string {
  switch (phase) {
    case "classifying":
      return "Classifying query…";
    case "researching":
      return "Brainstorming…";
    case "writing":
      return "Generating answer…";
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

/** One line per research step, for the collapsed list. */
export function describeAskStep(step: AskStep): string {
  if (step.kind === "searching") {
    const queries = step.queries || [];
    if (queries.length === 0) return "searching";
    if (queries.length === 1) return `searching “${queries[0]}”`;
    return `searching ${queries.length} queries`;
  }
  if (step.kind === "reasoning") return "thinking";
  if (step.kind === "found") {
    return `found ${step.count} ${step.count === 1 ? "result" : "results"}`;
  }
  if (step.kind === "timeout") return `timed out (attempt ${step.attempt}/${step.max})`;
  if (step.kind === "retrying") return `retrying (attempt ${step.attempt}/${step.max})`;
  if (step.kind === "gave_up") return "gave up";
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

/**
 * The href a citation marker is rewritten to before markdown parses it.
 *
 * `#cite-<n>` is a sentinel the `a` renderer intercepts: it knows the
 * citation index and can point at the real source URL.
 */
export const ASK_CITE_PREFIX = "#cite-";

/**
 * Rewrite the `[n]` / `[n,m]` markers into markdown links.
 *
 * This is the same trick Uttaram uses (`useChat.tsx`): the marker becomes a
 * link whose href is a sentinel, and the link renderer turns it back into a
 * citation pill that points at the matching source.
 *
 * A marker that is already a markdown link (`[1](https://…)`) is left alone —
 * the negative lookahead keeps the rewrite away from real links.
 */
export function preprocessAskCitations(text: string): string {
  if (!text) return text;
  return text.replace(
    /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g,
    (match, inner: string) => {
      const numbers = inner
        .split(",")
        .map((part) => part.trim())
        .filter((part) => /^\d+$/.test(part));
      if (numbers.length === 0) return match;
      return numbers.map((n) => `[${n}](${ASK_CITE_PREFIX}${n})`).join("");
    },
  );
}

/**
 * The answer text with its citation markers back in `[n]` form.
 *
 * The copy action uses it, so the clipboard carries the plain marker and not
 * the internal sentinel (Uttaram's `MessageActions/Copy.tsx` does the same).
 */
export function normaliseCitationMarkers(text: string): string {
  return text.replace(
    /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]\((?:#cite-\d+(?:#cite-\d+)*)\)/g,
    (_match, inner: string) => `[${inner.replace(/\s+/g, "")}]`,
  );
}

// ---------------------------------------------------------------------------
// The thread model (spec §D.1)
// ---------------------------------------------------------------------------

/** One turn of a thread: one query, one answer. */
export interface AskTurn {
  id: string;
  query: string;
  mode: AskMode;
  sources: AskSourceKind[];
  answer: string;
  /** The `sources` frame, so reopening keeps the citations live. */
  sourcesList: AskSource[];
  /** The research timeline, so reopening keeps the stages. */
  steps: AskStep[];
  /** Media fetched on-demand for this turn. */
  media?: AskMedia[];
  usage?: AskUsage;
  error?: AskError;
  createdAt: number;
}

/** A thread of turns — the Ask canvas's unit of continuity. */
export interface AskThread {
  id: string;
  /** The first turn's query, truncated. */
  title: string;
  turns: AskTurn[];
  createdAt: number;
  updatedAt: number;
  /**
   * How many turns the thread holds.
   *
   * The list endpoint ships NO turn bodies — only this count — so the
   * history rail stays cheap however long the history gets.
   */
  turnCount: number;
  /**
   * The group the thread is filed under — null when it is uncategorized.
   *
   * The group is the SERVER's business: it comes with the thread and it is
   * changed with a PATCH, never by the browser on its own.
   */
  groupId: string | null;
}

/**
 * A group of threads — the named bucket the Ask history is sorted into.
 *
 * Uttaram calls them projects; the shape and the rules are the same: a
 * thread belongs to one group (or to none), and deleting a group leaves its
 * threads behind, uncategorized.
 */
export interface AskGroup {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** How many threads the group holds right now. */
  threadCount: number;
}

/**
 * The OLD storage key — the threads the browser used to keep.
 *
 * It is READ once, on the first load, and then removed: the threads live on
 * the server now (job 150 §B). This is the only place the browser's Ask
 * history is read.
 */
export const ASK_THREADS_KEY = "sarathy.ask.threads";
/** The title of a thread is the first query, clipped. */
export const ASK_TITLE_MAX = 80;

/**
 * The v1 storage key — the flat history rail.
 *
 * @deprecated kept so old imports still typecheck; the Ask canvas has no
 * history rail any more (spec §C). It is migrated away on the first load.
 */
export const ASK_HISTORY_KEY = "sarathy.ask.history";

let idCounter = 0;

/** A stable, unique id for a thread or a turn. */
export function askId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** The thread title: the first query, clipped to `ASK_TITLE_MAX`. */
export function askThreadTitle(query: string): string {
  const flat = (query || "").replace(/\s+/g, " ").trim();
  return flat.length > ASK_TITLE_MAX ? `${flat.slice(0, ASK_TITLE_MAX)}…` : flat;
}

/** Build the thread that holds one first turn. */
export function createAskThread(turn: AskTurn, id?: string): AskThread {
  const now = turn.createdAt || Date.now();
  return {
    id: id ?? turn.id,
    title: askThreadTitle(turn.query),
    turns: [turn],
    createdAt: now,
    updatedAt: now,
    turnCount: 1,
    groupId: null,
  };
}

/**
 * Append a turn to a thread.
 *
 * A thread that is not in the list yet is created — that is how the first
 * turn of a new conversation becomes a thread.
 */
export function appendAskTurn(
  threads: AskThread[],
  threadId: string,
  turn: AskTurn,
): AskThread[] {
  const existing = threads.find((thread) => thread.id === threadId);
  if (!existing) {
    return [createAskThread(turn, threadId), ...threads];
  }
  return threads.map((thread) =>
    thread.id === threadId
      ? {
          ...thread,
          // A thread born inside a group is created empty, before it has a
          // question: the first question names it, exactly as the server
          // names it.
          title: thread.title || askThreadTitle(turn.query),
          turns: [...thread.turns, turn],
          turnCount: thread.turns.length + 1,
          updatedAt: turn.createdAt || Date.now(),
        }
      : thread,
  );
}

// ---------------------------------------------------------------------------
// The thread store — the SERVER is the source of truth
//
// Ask history used to live in the browser's `localStorage`: browser-local,
// capped at fifty, lost with the data, invisible from any other device. The
// gateway owns the threads now, the way it owns the chat sessions (job 150
// §B).
//
// The store below is the ONE copy of the thread data in the browser: the Ask
// canvas and the history list both read it, so no component can keep a
// private copy the others do not see.
// ---------------------------------------------------------------------------

/** The Ask thread endpoints. */
export const ASK_THREADS_ENDPOINT = "/api/ask/threads";

const threadStore = new Map<string, AskThread>();
const threadListListeners = new Set<() => void>();

function notifyThreadList(): void {
  threadListListeners.forEach((listener) => listener());
}

/** Every thread the browser knows about, newest first. */
export function getAskThreads(): AskThread[] {
  return Array.from(threadStore.values()).sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
  );
}

/** Subscribe to the thread list. */
export function subscribeAskThreadList(listener: () => void): () => void {
  threadListListeners.add(listener);
  return () => {
    threadListListeners.delete(listener);
  };
}

/** Put a thread into the store, replacing whatever was there. */
export function putAskThread(thread: AskThread): void {
  threadStore.set(thread.id, thread);
  notifyThreadList();
}

/** Attach media to one turn of a thread, in the store. */
export function setAskTurnMedia(
  threadId: string,
  turnId: string,
  media: AskMedia[],
): void {
  const thread = threadStore.get(threadId);
  if (!thread) return;
  threadStore.set(threadId, {
    ...thread,
    updatedAt: Date.now(),
    turns: thread.turns.map((turn) =>
      turn.id === turnId ? { ...turn, media: media.length ? [...media] : undefined } : turn,
    ),
  });
  notifyThreadList();
}

function askHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = askAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** One turn as the server stores it. */
function turnPayload(turn: AskTurn): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: turn.id,
    query: turn.query,
    answer: turn.answer,
    mode: turn.mode,
    sources: turn.sources,
    sourcesList: turn.sourcesList,
    steps: turn.steps,
    createdAt: turn.createdAt,
  };
  if (turn.media?.length) payload.media = turn.media;
  if (turn.usage) payload.usage = turn.usage;
  if (turn.error) payload.error = turn.error;
  return payload;
}

/** One stored turn as the UI's turn. */
function toTurn(value: any): AskTurn | null {
  if (!value || typeof value !== "object") return null;
  if (typeof value.query !== "string") return null;
  const turn: AskTurn = {
    id: typeof value.id === "string" && value.id ? value.id : askId("turn"),
    query: value.query,
    mode: (value.mode || "speed") as AskMode,
    sources: Array.isArray(value.sources) ? value.sources : ["web"],
    answer: typeof value.answer === "string" ? value.answer : "",
    sourcesList: Array.isArray(value.sourcesList) ? value.sourcesList : [],
    steps: Array.isArray(value.steps) ? value.steps : [],
    createdAt: Number(value.createdAt) || Date.now(),
  };
  if (Array.isArray(value.media) && value.media.length) turn.media = value.media;
  if (value.usage) turn.usage = value.usage;
  if (value.error) turn.error = value.error;
  return turn;
}

/** Coerce a stored payload into a thread, dropping anything malformed. */
function toThread(value: any): AskThread | null {
  if (!value || typeof value !== "object") return null;
  const raw: unknown[] = Array.isArray(value.turns) ? value.turns : [];
  const turns = raw
    .map(toTurn)
    .filter((turn): turn is AskTurn => turn !== null);
  if (turns.length === 0) return null;
  const createdAt = Number(value.createdAt) || turns[0].createdAt || Date.now();
  return {
    id: typeof value.id === "string" && value.id ? value.id : askId("thread"),
    title:
      typeof value.title === "string" && value.title
        ? value.title
        : askThreadTitle(turns[0].query),
    turns,
    createdAt,
    updatedAt: Number(value.updatedAt) || createdAt,
    turnCount: turns.length,
    groupId: typeof value.groupId === "string" ? value.groupId : null,
  };
}

/**
 * Read the thread list from the server.
 *
 * The list carries NO turn bodies — the title, the turn count and the
 * timestamps only — so the history rail stays cheap however long the
 * history gets. The bodies the browser already holds are kept: the list
 * does not carry them, and dropping them would empty the open thread.
 */
export async function loadAskThreads(): Promise<AskThread[]> {
  const res = await fetch(ASK_THREADS_ENDPOINT, { headers: askHeaders() });
  if (!res.ok) throw new Error(`Could not load the Ask threads (${res.status})`);
  const data = await res.json();
  const rows = Array.isArray(data?.threads) ? data.threads : [];

  const known = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    known.add(row.id);
    const existing = threadStore.get(row.id);
    const count = Number(row.turnCount);
    threadStore.set(row.id, {
      id: row.id,
      title: typeof row.title === "string" ? row.title : "",
      turns: existing?.turns ?? [],
      createdAt: Number(row.createdAt) || existing?.createdAt || Date.now(),
      updatedAt: Number(row.updatedAt) || existing?.updatedAt || Date.now(),
      turnCount: Number.isFinite(count) ? count : existing?.turnCount ?? 0,
      groupId: typeof row.groupId === "string" ? row.groupId : null,
    });
  }
  // A thread the server no longer knows about is gone — it was deleted.
  for (const id of Array.from(threadStore.keys())) {
    if (!known.has(id)) threadStore.delete(id);
  }
  notifyThreadList();
  return getAskThreads();
}

/**
 * Read one thread with its turns.
 *
 * This is what restores a thread in the canvas: the sources, the research
 * steps and the media all come back with it, so it renders exactly as it
 * did live.
 */
export async function loadAskThread(id: string): Promise<AskThread | null> {
  if (!id) return null;
  const res = await fetch(`${ASK_THREADS_ENDPOINT}/${encodeURIComponent(id)}`, {
    headers: askHeaders(),
  });
  // An unknown thread is not an error here: the canvas simply has nothing
  // to show, and the store is left alone (a thread that is being streamed
  // into does not exist on the server yet).
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load the Ask thread (${res.status})`);

  const data = await res.json();
  const raw: unknown[] = Array.isArray(data?.turns) ? data.turns : [];
  const turns = raw
    .map(toTurn)
    .filter((turn): turn is AskTurn => turn !== null);
  const meta = data?.thread ?? {};
  const thread: AskThread = {
    id: typeof meta.id === "string" ? meta.id : id,
    title: typeof meta.title === "string" ? meta.title : "",
    turns,
    createdAt: Number(meta.createdAt) || Date.now(),
    updatedAt: Number(meta.updatedAt) || Date.now(),
    turnCount: Number(meta.turnCount) || turns.length,
    groupId: typeof meta.groupId === "string" ? meta.groupId : null,
  };
  putAskThread(thread);
  return thread;
}

/** Create (or replace) one thread on the server. */
export async function postAskThread(thread: AskThread): Promise<AskThread | null> {
  const res = await fetch(ASK_THREADS_ENDPOINT, {
    method: "POST",
    headers: askHeaders(),
    body: JSON.stringify({
      id: thread.id,
      title: thread.title,
      turns: thread.turns.map(turnPayload),
      groupId: thread.groupId ?? null,
    }),
  });
  if (!res.ok) throw new Error(`Could not save the Ask thread (${res.status})`);
  const data = await res.json();
  const meta = data?.thread ?? {};
  return {
    id: typeof meta.id === "string" ? meta.id : thread.id,
    title: typeof meta.title === "string" ? meta.title : thread.title,
    turns: thread.turns,
    createdAt: Number(meta.createdAt) || thread.createdAt,
    updatedAt: Number(meta.updatedAt) || thread.updatedAt,
    turnCount: Number(meta.turnCount) || thread.turns.length,
    groupId: typeof meta.groupId === "string" ? meta.groupId : thread.groupId,
  };
}

/** Forget a thread — on the server, and in the browser's store. */
export async function deleteAskThread(id: string): Promise<void> {
  if (!id) return;
  const res = await fetch(`${ASK_THREADS_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: askHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Could not delete the Ask thread (${res.status})`);
  }
  threadStore.delete(id);
  notifyThreadList();
}

// ---------------------------------------------------------------------------
// The group store — the SERVER is the source of truth
//
// The Ask history is not a flat list any more: the threads are sorted into
// named GROUPS (Uttaram calls them projects). The groups live on the server
// beside the threads, and the store below is the ONE copy of them in the
// browser — the history list reads it instead of keeping a private copy.
//
// The rules are Uttaram's: a thread belongs to one group or to none, a
// thread can be moved, and deleting a group does NOT delete its threads —
// they fall back to uncategorized.
// ---------------------------------------------------------------------------

/** The Ask group endpoints. */
export const ASK_GROUPS_ENDPOINT = "/api/ask/groups";

const groupStore = new Map<string, AskGroup>();
const groupListeners = new Set<() => void>();

/**
 * The order the SERVER sent the groups in.
 *
 * Two groups created in the same millisecond share a timestamp, and the
 * server breaks that tie by the order it created them in. The browser keeps
 * that order so the sections here are the sections there.
 */
const groupOrder = new Map<string, number>();

function notifyGroups(): void {
  groupListeners.forEach((listener) => listener());
}

/** Every group the browser knows about, newest first. */
export function getAskGroups(): AskGroup[] {
  return Array.from(groupStore.values()).sort(
    (a, b) =>
      b.createdAt - a.createdAt ||
      (groupOrder.get(a.id) ?? 0) - (groupOrder.get(b.id) ?? 0),
  );
}

/** Subscribe to the group list. */
export function subscribeAskGroups(listener: () => void): () => void {
  groupListeners.add(listener);
  return () => {
    groupListeners.delete(listener);
  };
}

/** Coerce a stored payload into a group, dropping anything malformed. */
function toGroup(value: any): AskGroup | null {
  if (!value || typeof value !== "object") return null;
  if (typeof value.id !== "string" || !value.id) return null;
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : "",
    description: typeof value.description === "string" ? value.description : "",
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Number(value.createdAt) || Date.now(),
    threadCount: Number(value.threadCount) || 0,
  };
}

/** Read the groups from the server. */
export async function loadAskGroups(): Promise<AskGroup[]> {
  const res = await fetch(ASK_GROUPS_ENDPOINT, { headers: askHeaders() });
  if (!res.ok) throw new Error(`Could not load the Ask groups (${res.status})`);
  const data = await res.json();
  const rows = Array.isArray(data?.groups) ? data.groups : [];

  groupStore.clear();
  groupOrder.clear();
  rows.forEach((row: any, index: number) => {
    const group = toGroup(row);
    if (!group) return;
    groupStore.set(group.id, group);
    groupOrder.set(group.id, index);
  });
  notifyGroups();
  return getAskGroups();
}

/** The first load of the groups — a failed read leaves the list alone. */
export function ensureAskGroupsLoaded(): Promise<AskGroup[]> {
  return loadAskGroups().catch(() => getAskGroups());
}

/** Create a group on the server and put it in the store. */
export async function createAskGroup(
  name: string,
  description = "",
): Promise<AskGroup> {
  const res = await fetch(ASK_GROUPS_ENDPOINT, {
    method: "POST",
    headers: askHeaders(),
    body: JSON.stringify({ name, description }),
  });
  if (!res.ok) throw new Error(`Could not create the Ask group (${res.status})`);
  const data = await res.json();
  const group = toGroup(data?.group);
  if (!group) throw new Error("The gateway did not return the group");
  groupStore.set(group.id, group);
  // A group just made is the newest one: it leads the list, even when it
  // shares its timestamp with another group.
  groupOrder.set(group.id, -1);
  notifyGroups();
  return group;
}

/** Rename a group on the server (or change its description). */
export async function renameAskGroup(
  id: string,
  name: string,
  description?: string,
): Promise<AskGroup> {
  const res = await fetch(`${ASK_GROUPS_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: askHeaders(),
    body: JSON.stringify(description === undefined ? { name } : { name, description }),
  });
  if (!res.ok) throw new Error(`Could not rename the Ask group (${res.status})`);
  const data = await res.json();
  const group = toGroup(data?.group);
  if (!group) throw new Error("The gateway did not return the group");
  groupStore.set(group.id, group);
  notifyGroups();
  return group;
}

/**
 * Delete a group on the server.
 *
 * The threads of the group SURVIVE: the gateway clears their group and they
 * fall back to uncategorized. The list is read again afterwards, so the
 * threads come back where they belong.
 */
export async function deleteAskGroup(id: string): Promise<void> {
  if (!id) return;
  const res = await fetch(`${ASK_GROUPS_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: askHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Could not delete the Ask group (${res.status})`);
  }
  groupStore.delete(id);
  notifyGroups();
}

/**
 * Move a thread into a group — or out of every group.
 *
 * `groupId` of null is uncategorized. The move is the server's business:
 * the thread is PATCHed and the list is read again, so what the history
 * shows is what the server holds.
 */
export async function moveAskThread(
  threadId: string,
  groupId: string | null,
): Promise<void> {
  if (!threadId) return;
  const res = await fetch(`${ASK_THREADS_ENDPOINT}/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    headers: askHeaders(),
    body: JSON.stringify({ groupId }),
  });
  if (!res.ok) throw new Error(`Could not move the Ask thread (${res.status})`);
  const thread = threadStore.get(threadId);
  if (thread) {
    threadStore.set(threadId, { ...thread, groupId });
    notifyThreadList();
  }
}

/**
 * Start a new thread INSIDE a group.
 *
 * The thread is created on the server first — with the group it belongs to —
 * and only then is the canvas pointed at it. A thread that was born in the
 * browser would have no group until it was saved.
 */
export async function createAskThreadInGroup(groupId: string | null): Promise<AskThread> {
  const id = askId("thread");
  const res = await fetch(ASK_THREADS_ENDPOINT, {
    method: "POST",
    headers: askHeaders(),
    body: JSON.stringify({ id, title: "", groupId }),
  });
  if (!res.ok) throw new Error(`Could not create the Ask thread (${res.status})`);
  const data = await res.json();
  const meta = data?.thread ?? {};
  const thread: AskThread = {
    id: typeof meta.id === "string" ? meta.id : id,
    title: typeof meta.title === "string" ? meta.title : "",
    turns: [],
    createdAt: Number(meta.createdAt) || Date.now(),
    updatedAt: Number(meta.updatedAt) || Date.now(),
    turnCount: Number(meta.turnCount) || 0,
    groupId: typeof meta.groupId === "string" ? meta.groupId : groupId,
  };
  putAskThread(thread);
  return thread;
}

// ---------------------------------------------------------------------------
// Which groups are collapsed
//
// The collapsed state lives in the shared module, not in a component: the
// history list is unmounted every time the Sessions surface switches to the
// chats, and a section that springs open again would be a papercut. The
// state lasts for the session and no longer.
// ---------------------------------------------------------------------------

const collapsedGroups = new Set<string>();
const collapseListeners = new Set<() => void>();

/** The groups that are collapsed. */
export function getCollapsedAskGroups(): string[] {
  return Array.from(collapsedGroups);
}

/** True when the group is collapsed. */
export function isAskGroupCollapsed(id: string): boolean {
  return collapsedGroups.has(id);
}

/** Collapse a group, or open it again. */
export function toggleAskGroupCollapsed(id: string): void {
  if (!id) return;
  if (collapsedGroups.has(id)) collapsedGroups.delete(id);
  else collapsedGroups.add(id);
  collapseListeners.forEach((listener) => listener());
}

/** Subscribe to the collapsed state. */
export function subscribeAskGroupCollapse(listener: () => void): () => void {
  collapseListeners.add(listener);
  return () => {
    collapseListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// The one-time migration of the browser's Ask history
// ---------------------------------------------------------------------------

/**
 * What one legacy key held.
 *
 * `present` says the key exists at all; `unreadable` says it exists but its
 * payload is not a shape this build understands. Keeping the two apart is
 * what stops the migration from deleting a history it could not read.
 */
interface LegacyRead {
  present: boolean;
  unreadable: boolean;
  threads: AskThread[];
  raw: string | null;
}

const EMPTY_READ: LegacyRead = { present: false, unreadable: false, threads: [], raw: null };

/** Where an unreadable legacy payload is parked instead of being deleted. */
export const ASK_ORPHANED_KEY = "sarathy.ask.orphaned";

/**
 * The threads the browser kept, read from the old key.
 *
 * A payload that parses to an array but yields no thread this build can read
 * is reported as `unreadable` rather than as an empty history: the two look
 * alike from here, and only one of them is safe to delete.
 */
function readLocalThreads(): LegacyRead {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ASK_THREADS_KEY);
  } catch {
    return EMPTY_READ;
  }
  if (raw === null) return EMPTY_READ;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, unreadable: true, threads: [], raw };
  }
  if (!Array.isArray(parsed)) {
    return { present: true, unreadable: true, threads: [], raw };
  }
  const threads = parsed
    .map(toThread)
    .filter((thread): thread is AskThread => thread !== null);
  // An empty array is an empty history; a full one that yields nothing is a
  // shape this build does not know.
  return {
    present: true,
    unreadable: parsed.length > 0 && threads.length === 0,
    threads,
    raw,
  };
}

/**
 * The v1 flat history, read from the old key.
 *
 * Each entry becomes a single-turn thread. The v1 key is only read here —
 * the one place the browser's Ask history is still touched.
 */
function readLocalHistory(): LegacyRead {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ASK_HISTORY_KEY);
  } catch {
    return EMPTY_READ;
  }
  if (raw === null) return EMPTY_READ;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, unreadable: true, threads: [], raw };
  }
  if (!Array.isArray(parsed)) {
    return { present: true, unreadable: true, threads: [], raw };
  }

  const entries = parsed.filter((entry) => entry && typeof entry.query === "string");
  const threads = entries.map((entry) => {
    const turn: AskTurn = {
      id: entry.id || askId("turn"),
      query: entry.query,
      mode: (entry.mode || "speed") as AskMode,
      sources: Array.isArray(entry.sources) ? entry.sources : ["web"],
      answer: typeof entry.answer === "string" ? entry.answer : "",
      sourcesList: [],
      steps: [],
      createdAt: Number(entry.createdAt) || Date.now(),
    };
    return createAskThread(turn, entry.id || turn.id);
  });
  return {
    present: true,
    unreadable: parsed.length > 0 && entries.length === 0,
    threads,
    raw,
  };
}

let migration: Promise<void> | null = null;

/**
 * The one-time migration of the browser's Ask history onto the server.
 *
 * The threads the browser kept are POSTed to the server and the key is
 * removed — a user's existing history must not vanish.
 *
 * It runs ONCE: the REMOVED KEY is the guard (there is nothing left to
 * carry over the second time), and the in-flight promise keeps two surfaces
 * from starting it at the same time.
 *
 * A POST that fails leaves the key alone, so the next load retries instead
 * of losing the history.
 */
export function migrateAskThreads(): Promise<void> {
  const legacy = readLocalThreads();
  const history = readLocalHistory();
  const pending = [...legacy.threads, ...history.threads];

  if (pending.length === 0) {
    // Nothing readable to carry over. A key that is ABSENT, or that holds an
    // empty array, is safe to remove. A key we could not read is NOT: it may
    // hold a history whose shape this build does not know, and deleting it
    // would destroy the only copy. Park it instead and leave it alone.
    quarantineUnreadable(legacy);
    quarantineUnreadable(history);
    if (legacy.present && !legacy.unreadable) removeKey(ASK_THREADS_KEY);
    if (history.present && !history.unreadable) removeKey(ASK_HISTORY_KEY);
    return Promise.resolve();
  }

  if (migration) return migration;
  migration = runAskMigration(pending, legacy, history).finally(() => {
    migration = null;
  });
  return migration;
}

async function runAskMigration(
  pending: AskThread[],
  legacy: LegacyRead,
  history: LegacyRead,
): Promise<void> {
  let failed = false;
  for (const thread of pending) {
    try {
      await postAskThread(thread);
    } catch {
      failed = true;
    }
  }

  if (failed) {
    // The history stays where it is: a half-migrated history is better than
    // a lost one. The next load retries.
    return;
  }

  // The threads we understood are on the server now. Anything we could not
  // read is parked under its own key first, so clearing never loses it.
  quarantineUnreadable(legacy);
  quarantineUnreadable(history);
  removeKey(ASK_THREADS_KEY);
  removeKey(ASK_HISTORY_KEY);
}

/** Move an unreadable payload aside, under `ASK_ORPHANED_KEY`. */
function quarantineUnreadable(read: LegacyRead): void {
  if (!read.unreadable || read.raw === null) return;
  try {
    localStorage.setItem(ASK_ORPHANED_KEY, read.raw);
  } catch {
    /* storage blocked — the payload stays under its original key */
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage blocked — the threads are on the server anyway */
  }
}

/**
 * The first load: carry the browser's history over, then read the list.
 *
 * Both surfaces that show threads call this. The MIGRATION runs once (it is
 * guarded by the key it removes); the list is read every time, because the
 * Ask canvas may have added a thread since the list was last rendered.
 */
export function ensureAskThreadsLoaded(): Promise<AskThread[]> {
  return migrateAskThreads()
    .catch(() => undefined)
    .then(() => loadAskThreads())
    .catch(() => getAskThreads());
}

// ---------------------------------------------------------------------------
// The active-thread pointer
//
// The Sessions list ("Asks") opens a thread in the Ask tab. The two surfaces
// are never mounted at the same time, so the pointer lives here — module
// level, in the shared module — instead of in a prop chain.
// ---------------------------------------------------------------------------

let activeThreadId: string | null = null;
const threadListeners = new Set<() => void>();

/** The thread the Ask canvas is showing, if any. */
export function getActiveAskThreadId(): string | null {
  return activeThreadId;
}

/** Point the Ask canvas at a thread (or at nothing). */
export function setActiveAskThreadId(id: string | null): void {
  if (activeThreadId === id) return;
  activeThreadId = id;
  threadListeners.forEach((listener) => listener());
}

/** Subscribe to the active-thread pointer. */
export function subscribeAskThread(listener: () => void): () => void {
  threadListeners.add(listener);
  return () => {
    threadListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// The Ask history shortcut
//
// The Ask canvas cannot navigate by itself — the shells own the section
// state — so the request is raised here and picked up by the shell, exactly
// like the active-thread pointer above.
//
// The Sessions panel's `Chats / Asks` switch lives here too: the request
// selects the Asks list, and the panel follows whichever instance is on
// screen.
// ---------------------------------------------------------------------------

/** Which list the Sessions surface shows. */
export type AskListMode = "chats" | "asks";

let askListMode: AskListMode = "chats";
const listModeListeners = new Set<() => void>();
const historyListeners = new Set<() => void>();

/** The list the Sessions surface is showing. */
export function getAskListMode(): AskListMode {
  return askListMode;
}

/** Show one of the two lists. */
export function setAskListMode(mode: AskListMode): void {
  if (askListMode === mode) return;
  askListMode = mode;
  listModeListeners.forEach((listener) => listener());
}

/** Subscribe to the Sessions list mode. */
export function subscribeAskListMode(listener: () => void): () => void {
  listModeListeners.add(listener);
  return () => {
    listModeListeners.delete(listener);
  };
}

/**
 * Open the Ask history.
 *
 * The Ask history lives in the Sessions surface, behind its `Chats / Asks`
 * switch — this request selects that list AND asks the shell to navigate
 * there, so the history is one icon away from a cold Ask tab.
 */
export function requestAskHistory(): void {
  setAskListMode("asks");
  historyListeners.forEach((listener) => listener());
}

/** Subscribe to the request to open the Ask history. */
export function subscribeAskHistoryRequest(listener: () => void): () => void {
  historyListeners.add(listener);
  return () => {
    historyListeners.delete(listener);
  };
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

/** One turn of the engine's own history: `[role, text]`. */
export type AskHistoryTurn = [role: "human" | "assistant", text: string];

/**
 * How many earlier turns of a thread travel with a follow-up.
 *
 * The gateway caps the list at `ASK_MAX_HISTORY` (20 items = 10 turns), so this
 * stays comfortably inside it. Six turns is enough for a follow-up to resolve
 * "it", "that one" and "the second option" without dragging a whole thread into
 * every prompt.
 */
export const ASK_HISTORY_TURNS = 6;

/**
 * The conversation a follow-up is grounded in — the thread itself.
 *
 * A follow-up is only a follow-up if the engine can see what came before it, so
 * this is derived from the open thread rather than from an explicit "Reply"
 * click. Turns that errored or produced no answer are skipped: an empty
 * assistant message teaches the model nothing and burns context.
 *
 * Returns `undefined` for a thread's first turn, so the request stays exactly
 * as it was before (no `history` key on the wire).
 */
export function buildAskHistory(
  turns: AskTurn[],
  limit: number = ASK_HISTORY_TURNS,
): AskHistoryTurn[] | undefined {
  const usable = turns.filter(
    (turn) => !turn.error && turn.query.trim() && turn.answer.trim(),
  );
  if (usable.length === 0) return undefined;

  const recent = usable.slice(-limit);
  const history: AskHistoryTurn[] = [];
  for (const turn of recent) {
    history.push(["human", turn.query]);
    history.push(["assistant", turn.answer]);
  }
  return history;
}

export interface AskRunRequest {
  query: string;
  mode: AskMode;
  sources: AskSourceKind[];
  /** The chat session this turn belongs to. */
  sessionKey?: string;
  /** The passages quoted out of an earlier answer (spec §E). */
  quotes?: Quote[];
  /**
   * The conversation the engine grounds the answer in (spec §E).
   *
   * A "Reply" on an Ask turn sends that turn's question and answer here, so
   * the follow-up re-researches in the SAME thread.
   */
  history?: AskHistoryTurn[];
}

/** The turn being streamed — the live counterpart of a stored `AskTurn`. */
interface PendingTurn {
  id: string;
  threadId: string;
  query: string;
  mode: AskMode;
  sources: AskSourceKind[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// The media (spec 152 §C)
//
// The media used to be fetched only when the user tapped a button, so the
// default answer was text only. It is fetched on its own as soon as the
// answer is finished — and it is fetched HERE, in the ONE module both shells
// use, so the automatic fetch and the manual buttons cannot drift apart.
// ---------------------------------------------------------------------------

/** One image of the media search, in the shape the UI draws. */
export function mapAskImages(data: any): AskMedia[] {
  const list = Array.isArray(data?.images) ? data.images : [];
  return list
    .filter((item: any) => item && (item.url || item.img_src))
    .map((item: any) => ({
      kind: "image" as const,
      url: item.url || item.img_src,
      img_src: item.img_src || item.url,
      thumb: item.img_src || item.thumb || item.url,
      title: item.title || "",
    }));
}

/** One video of the media search, in the shape the UI draws. */
export function mapAskVideos(data: any): AskMedia[] {
  const list = Array.isArray(data?.videos) ? data.videos : [];
  return list
    .filter((item: any) => item && (item.url || item.iframe_src))
    .map((item: any) => ({
      kind: "video" as const,
      url: item.url,
      img_src: item.img_src || item.thumb,
      thumb: item.img_src || item.thumb,
      title: item.title || "",
      iframe_src: item.iframe_src,
      iframeUrl: item.iframe_src || item.iframeUrl,
    }));
}

/** What one media request needs. */
export interface AskMediaRequest {
  /** The turn's question — the engine rewrites it before it searches. */
  query: string;
  /** The thread's conversation, so the search knows what the turn is about. */
  history: AskHistoryTurn[] | undefined;
  /** The thread and the turn the media belongs to (gateway routing hints). */
  threadId: string | null;
  turnId: string;
}

/**
 * Fetch one kind of media for a turn.
 *
 * The request carries the thread and the turn ids, so the gateway attaches
 * the media to the STORED turn: a thread reopened from the server shows the
 * media and fetches nothing again.
 *
 * Throws when the request fails — the caller decides whether that is an
 * error the user has to read or a silent no-op.
 */
export async function fetchAskMedia(
  kind: "images" | "videos",
  request: AskMediaRequest,
): Promise<AskMedia[]> {
  const token = askAuthToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const body: Record<string, unknown> = {
    query: request.query,
    chatHistory: request.history && request.history.length ? request.history : [],
    thread_id: request.threadId,
    turn_id: request.turnId,
  };

  const res = await fetch(`/api/ask/${kind}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message =
      (data as any)?.error || (data as any)?.message || `Request failed (${res.status})`;
    throw new Error(message);
  }

  const data = await res.json();
  return kind === "images" ? mapAskImages(data) : mapAskVideos(data);
}

/**
 * Both kinds of media, in parallel — and SILENTLY.
 *
 * A failure of either one is not an error the user has to read: a text-only
 * answer is a valid outcome, and the manual buttons are there to retry.
 */
export async function fetchAskMediaQuiet(request: AskMediaRequest): Promise<{
  images: AskMedia[];
  videos: AskMedia[];
}> {
  const [images, videos] = await Promise.allSettled([
    fetchAskMedia("images", request),
    fetchAskMedia("videos", request),
  ]);
  return {
    images: images.status === "fulfilled" ? images.value : [],
    videos: videos.status === "fulfilled" ? videos.value : [],
  };
}

/**
 * The Ask session — the hook both shells use.
 *
 * It owns the transport (POST /api/ask, read the NDJSON stream, fold every
 * frame through `reduceAskFrame`), the Stop button's abort, and the thread
 * list. Both the desktop and the mobile view call it, so the two behave
 * identically.
 */
export function useAskStream() {
  const [state, setState] = useState<AskState>(initialAskState);
  const [threads, setThreads] = useState<AskThread[]>(() => getAskThreads());
  const [threadId, setThreadId] = useState<string | null>(() => getActiveAskThreadId());
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The thread being streamed into — it does not exist on the server yet. */
  const liveThreadRef = useRef<string | null>(null);
  /** The turns whose media was already fetched on its own (spec 152 §C). */
  const autoMediaRef = useRef<Set<string>>(new Set());

  // The store is the ONE copy of the thread data: the canvas and the
  // history list both read it, so they cannot drift apart.
  useEffect(() => subscribeAskThreadList(() => setThreads(getAskThreads())), []);

  // The Sessions list can point the canvas at a thread while it is mounted.
  useEffect(() => {
    const apply = () => {
      const next = getActiveAskThreadId();
      setThreadId(next);
      if (!next) {
        setPending(null);
        setState(initialAskState);
        return;
      }
      // A thread that is being streamed into is not on the server yet —
      // reading it back would only race with the turn that is landing.
      if (next === liveThreadRef.current) return;
      void loadAskThread(next).catch(() => undefined);
    };
    apply();
    return subscribeAskThread(apply);
  }, []);

  // The first load: carry the browser's history over, then read the list.
  useEffect(() => {
    void ensureAskThreadsLoaded();
  }, []);

  /**
   * Store a finished turn in its thread.
   *
   * The thread is the canvas's unit of continuity: a follow-up query lands in
   * the same thread, so the Ask tab reads as one conversation. The gateway
   * recorded the same turn when the stream completed — this is the
   * browser's copy of it, so the canvas can draw it and the list can count
   * it.
   */
  const commit = useCallback((turn: AskTurn, targetThreadId: string) => {
    const next = appendAskTurn(getAskThreads(), targetThreadId, turn);
    threadStore.clear();
    next.forEach((thread) => threadStore.set(thread.id, thread));
    notifyThreadList();
  }, []);

  /**
   * The media of a finished turn, fetched on its own (spec 152 §C).
   *
   * The answer used to be text only: the images and the videos were there,
   * but only after the user tapped a button. They are now fetched as soon
   * as the answer is finished — in parallel, and SILENTLY: a failure is not
   * an error the user has to read, and a text-only answer is a valid
   * outcome.
   *
   * The request carries the thread and the turn ids, so the gateway attaches
   * the media to the STORED turn: a thread reopened from the server shows
   * the media and fetches nothing again.
   */
  const autoFetchMedia = useCallback(async (turn: AskTurn, targetThreadId: string) => {
    // The turn is already in the store — `commit` put it there a moment ago
    // — so the thread's turns ARE the history, this turn included.
    const stored = getAskThreads().find((thread) => thread.id === targetThreadId);
    const history = buildAskHistory(stored?.turns ?? []);
    const { images, videos } = await fetchAskMediaQuiet({
      query: turn.query,
      history,
      threadId: targetThreadId,
      turnId: turn.id,
    });
    const media = [...images, ...videos];
    if (!media.length) return;
    setAskTurnMedia(targetThreadId, turn.id, media);
  }, []);

  const run = useCallback(
    async (request: AskRunRequest) => {
      const query = request.query.trim();
      if (!query) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // The live turn belongs to the open thread — or opens a new one.
      const targetThreadId = threadId ?? askId("thread");
      const live: PendingTurn = {
        id: askId("turn"),
        threadId: targetThreadId,
        query,
        mode: request.mode,
        sources: request.sources,
        createdAt: Date.now(),
      };

      liveThreadRef.current = targetThreadId;
      setThreadId(targetThreadId);
      setActiveAskThreadId(targetThreadId);
      setPending(live);
      setState({ ...initialAskState, streaming: true });

      // The live state is folded HERE, not through the React state: the
      // commit at the end of the stream must see the final state, and a
      // setState callback would still be one render behind.
      let folded = initialAskState;
      const apply = (frame: AskFrame) => {
        folded = reduceAskFrame(folded, frame);
        setState(folded);
      };

      const finish = () => {
        const turn: AskTurn = {
          id: live.id,
          query: live.query,
          mode: live.mode,
          sources: live.sources,
          answer: folded.answer,
          sourcesList: folded.sources,
          steps: folded.steps,
          media: folded.media && folded.media.length > 0 ? folded.media : undefined,
          usage: folded.usage ?? undefined,
          error: folded.error ?? undefined,
          createdAt: live.createdAt,
        };
        commit(turn, targetThreadId);
        setPending(null);
        // The media of this turn, fetched on its own (spec 152 §C). It runs
        // in the background — the answer is already on the screen — and it
        // fails silently. A turn that errored has no answer to illustrate,
        // so it is left alone.
        if (!turn.error && !autoMediaRef.current.has(turn.id)) {
          autoMediaRef.current.add(turn.id);
          void autoFetchMedia(turn, targetThreadId);
        }
      };

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        const token = askAuthToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        const body: Record<string, unknown> = {
          query,
          mode: request.mode,
          sources: request.sources,
          session_key: request.sessionKey,
          // The thread and the turn this turn belongs to (job 150 §A): the
          // gateway records the finished turn under these ids, so the
          // thread that is opened later is the thread that was written.
          thread_id: targetThreadId,
          turn_id: live.id,
        };
        // Only sent when there is something to send — an empty array would
        // be noise the engine has to look at.
        if (request.quotes?.length) body.quotes = request.quotes;
        if (request.history?.length) body.history = request.history;

        const response = await fetch("/api/ask", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
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
          apply({ type: "error", data: { message, code: "backend_unavailable" } });
          finish();
          return;
        }

        if (!response.body) {
          apply({
            type: "error",
            data: { message: "The ask backend sent no stream", code: "no_stream" },
          });
          finish();
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
            apply(frame);
            if (frame.type === "done") finish();
          }
        }

        if (buffer.trim()) {
          const { frames } = parseAskFrames(`${buffer}\n`);
          for (const frame of frames) {
            apply(frame);
            if (frame.type === "done") finish();
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          apply({ type: "done" });
          finish();
          return;
        }
        apply({
          type: "error",
          data: {
            message: err instanceof Error ? err.message : "The ask failed",
            code: "ask_failed",
          },
        });
        finish();
      } finally {
        abortRef.current = null;
        liveThreadRef.current = null;
      }
    },
    [commit, threadId, autoFetchMedia],
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
    setState((prev) => ({
      ...prev,
      streaming: false,
      phase: prev.phase === "error" ? "error" : "done",
    }));
  }, []);

  /**
   * Start a NEW ask.
   *
   * The canvas is emptied AND the active thread is dropped, so the next
   * query opens a fresh thread. The old thread stays in the history — that
   * is the whole point of the button: without it, every query landed in the
   * open thread forever and there was no way out.
   */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(initialAskState);
    setPending(null);
    setThreadId(null);
    setActiveAskThreadId(null);
  }, []);

  /**
   * Show a thread in the canvas.
   *
   * The turns are read back from the server — the sources, the research
   * steps and the media included — so the thread renders exactly as it did
   * live.
   */
  const openThread = useCallback((id: string | null) => {
    setThreadId(id);
    setActiveAskThreadId(id);
    setPending(null);
    setState(initialAskState);
    if (id) void loadAskThread(id).catch(() => undefined);
  }, []);

  /** Forget one thread — on the server, and in the browser's store. */
  const forgetThread = useCallback(async (id: string) => {
    await deleteAskThread(id);
    // The thread that was open in the canvas is gone: the canvas empties.
    if (getActiveAskThreadId() === id) setActiveAskThreadId(null);
  }, []);

  /**
   * The turns the canvas renders: the open thread's turns, plus the live one.
   */
  const turns = useMemo<AskTurn[]>(() => {
    const thread = threads.find((item) => item.id === threadId);
    const base = thread ? thread.turns : [];
    if (!pending) return base;
    const live: AskTurn = {
      id: pending.id,
      query: pending.query,
      mode: pending.mode,
      sources: pending.sources,
      answer: state.answer,
      sourcesList: state.sources,
      steps: state.steps,
      media: state.media && state.media.length > 0 ? [...state.media] : undefined,
      usage: state.usage ?? undefined,
      error: state.error ?? undefined,
      createdAt: pending.createdAt,
    };
    return [...base, live];
  }, [threads, threadId, pending, state]);

  return {
    state,
    /** The threads, newest first. */
    threads,
    /** @deprecated the v1 history rail — the threads take its place. */
    history: threads,
    /** The turns the canvas renders. */
    turns,
    /** The thread the canvas is showing. */
    threadId,
    run,
    stop,
    /** Start a new ask: the canvas empties and the next query is a new thread. */
    reset,
    openThread,
    forgetThread,
    updateMedia: (turnId: string, media: AskMedia[]) => {
      if (!threadId) return;
      setAskTurnMedia(threadId, turnId, media);
    },
  };
}
