/**
 * Spec 155 — the cross-repo contract.
 *
 * The backend prompt tells the model which components it may use and shows a
 * worked example. Nothing in the backend can verify that those are real: the
 * parser lives here. An earlier revision of the prompt taught
 * `Series([Point({x, y})])`, which parses to a NULL root with 21 type errors —
 * so every widget the model produced would have been dropped and the user shown
 * raw DSL. These tests are the guard against that class of drift.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createParser } from "@openuidev/react-lang";

import { uiLibrary } from "@/lib/openuiRenderer";

const BACKEND = "/home/kspviswa/ws/uttaram-backend/src/lib/ask/openui.ts";
const BACKTICKS = [...Array(3)].map(() => String.fromCharCode(92, 96)).join("");
const NEWLINE = String.fromCharCode(10);

function backendSource(): string {
  return readFileSync(BACKEND, "utf8");
}

function backendAllowlist(): string[] {
  const block = backendSource()
    .split("OPENUI_ALLOWED_COMPONENTS = [")[1]
    .split("] as const")[0];
  return [...block.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]);
}

/** Every ```openui-lang fence inside RICH_WIDGET_INSTRUCTIONS. */
function promptExamples(): string[] {
  const src = backendSource();
  const instructions = src.split("export const RICH_WIDGET_INSTRUCTIONS")[1] ?? "";
  const parts = instructions.split(BACKTICKS + "openui-lang" + NEWLINE).slice(1);
  return parts
    .map((part) => part.split(BACKTICKS)[0])
    .filter((body) => body.includes("root ="));
}

function parseWithRealRenderer(source: string) {
  const lib = uiLibrary();
  const parser = createParser(lib.toJSONSchema() as never, lib.root as never);
  return parser.parse(source) as unknown as {
    root: unknown;
    meta: { errors?: { message?: string }[]; unresolved?: unknown[]; incomplete?: boolean };
  };
}

describe("spec 155 cross-repo contract", () => {
  it("every backend-allowlisted component exists in the dashboard catalog", () => {
    const names = new Set(Object.keys(uiLibrary().components));
    const allow = backendAllowlist();
    expect(allow.length).toBeGreaterThan(20);
    expect(allow.filter((n) => !names.has(n))).toEqual([]);
  });

  it("the prompt contains at least one worked example", () => {
    expect(promptExamples().length).toBeGreaterThan(0);
  });

  it("EVERY prompt example parses cleanly in the real renderer", () => {
    for (const example of promptExamples()) {
      const result = parseWithRealRenderer(example);
      expect(result.meta.errors ?? []).toEqual([]);
      expect(result.meta.unresolved ?? []).toEqual([]);
      expect(result.meta.incomplete).toBe(false);
      expect(result.root).toBeTruthy();
    }
  });

  it("the prompt does not teach a component the catalog lacks", () => {
    const names = new Set(Object.keys(uiLibrary().components));
    for (const example of promptExamples()) {
      const used = [...example.matchAll(/([A-Z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]);
      expect(used.filter((n) => !names.has(n))).toEqual([]);
    }
  });

  it("does not resurrect the Point({x, y}) chart API", () => {
    // LineChart takes (labels, [Series(category, values)]); Point does not exist.
    // Strip the prose first: the module documents the old API in a comment.
    const code = backendSource()
      .split(NEWLINE)
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join(NEWLINE);
    expect(code).not.toMatch(/Point\s*\(\s*\{/);
  });
});
