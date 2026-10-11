/**
 * Drift guard: every `<ReactMarkdown>` in the dashboard must render through the
 * shared `MD_COMPONENTS`.
 *
 * The emoji→icon swap (2026-10-11) lives in the shared markdown pipeline. Two
 * surfaces — the notification center and the thinking section — had rolled their
 * own `components` object, so they silently kept rendering raw emoji glyphs:
 * a parity gap Viswa had to find. Unit-testing each surface does not prevent the
 * NEXT surface from forgetting; this does.
 *
 * Same rule as `transcript.ts` and `channelIcons.tsx`: share the module, never
 * duplicate — duplication is how the surfaces drift.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = join(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" ? [] : walk(path);
    }
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

describe("markdown pipeline parity", () => {
  it("every ReactMarkdown call site spreads MD_COMPONENTS", () => {
    const offenders: string[] = [];

    for (const path of walk(SRC)) {
      const source = readFileSync(path, "utf8");
      if (!source.includes("<ReactMarkdown")) continue;
      // The definition file itself hosts the shared object.
      if (path.endsWith("lib/markdown.tsx")) continue;
      if (!source.includes("MD_COMPONENTS")) {
        offenders.push(path.replace(`${SRC}/`, ""));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("every ReactMarkdown call site installs the safe rehype pipeline", () => {
    const offenders: string[] = [];

    for (const path of walk(SRC)) {
      const source = readFileSync(path, "utf8");
      if (!source.includes("<ReactMarkdown")) continue;
      if (path.endsWith("lib/markdown.tsx")) continue;
      if (!source.includes("SAFE_REHYPE_PLUGINS")) {
        offenders.push(path.replace(`${SRC}/`, ""));
      }
    }

    expect(offenders).toEqual([]);
  });
});
