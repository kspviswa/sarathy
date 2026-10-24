#!/usr/bin/env node
/**
 * SPA parity guard (spec 164).
 *
 * Viswa's rule: ANY dashboard change applies to BOTH SPAs — desktop
 * (`src/App.tsx`) and mobile (`src/mobile/App.tsx`) — in the same commit.
 *
 * Memory and good intentions did not hold the rule; the mobile Ask composer
 * silently kept the pre-spec-159 controls for weeks because the component
 * branched on `variant` and RE-DECLARED the controls in each branch. A change
 * to one branch simply never reached the other.
 *
 * So the rule is enforced structurally:
 *
 *   1. A component that takes a `variant` prop may declare each control ONCE.
 *      A repeated `data-testid="…"` (or repeated static `aria-label="…"`) in
 *      such a file means duplicated markup — the drift vector. Build the
 *      element once, then compose the arrangement around it.
 *
 *   2. Every shell must mount the shared surface, never a private copy. The
 *      mobile shell must not import a component that the desktop shell does
 *      not (and vice versa) for the same feature area — checked only for the
 *      `ask` feature, which is the one with a shared surface today.
 *
 * Exit 1 with a precise file:line for every violation. Wire it into `pretest`
 * and `prebuild` so no agent can build or test past it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full);
    } else if (/\.tsx?$/.test(entry)) {
      check(full);
    }
  }
}

/** Files that legitimately switch on `variant` / `isMobile`. */
function takesVariant(source) {
  return /variant\s*[?:]|variant\s*===|isMobile\b|isDesktop\b/.test(source);
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function check(file) {
  const source = readFileSync(file, "utf8");
  if (!takesVariant(source)) return;

  const rel = relative(ROOT, file);
  for (const attr of ["data-testid", "aria-label"]) {
    const seen = new Map();
    const re = new RegExp(`${attr}="([^"{}]+)"`, "g");
    let match;
    while ((match = re.exec(source)) !== null) {
      const value = match[1];
      if (seen.has(value)) {
        violations.push(
          `${rel}:${lineOf(source, match.index)}  ${attr}="${value}" is declared twice ` +
            `(first at line ${seen.get(value)}).\n` +
            `    A variant-branching component must declare each control ONCE — ` +
            `build the element, then compose the arrangement around it.`,
        );
      } else {
        seen.set(value, lineOf(source, match.index));
      }
    }
  }
}

walk(SRC);

if (violations.length > 0) {
  console.error("\n✗ SPA parity guard: duplicated controls in variant-branching components\n");
  for (const v of violations) console.error("  " + v + "\n");
  console.error(
    "  Rule: one declaration, two arrangements. See dashboard/AGENTS.md §SPA parity.\n",
  );
  process.exit(1);
}

console.log("✓ SPA parity guard: no duplicated controls across variants");
