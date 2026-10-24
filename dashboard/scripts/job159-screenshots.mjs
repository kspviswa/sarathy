/**
 * Job 159 — Ask composer screenshots.
 *
 * Captures the Ask surface as Viswa's complaints see it:
 *   - desktop 1280x900, idle (composer row: sources/mode icons + circular Ask)
 *   - desktop 1280x900, streaming (the red Stop in the composer's slot)
 *   - mobile 390x844, idle (the compact composer stack)
 *
 * Usage:  node scripts/job159-screenshots.mjs
 *
 * The backend is NOT real: the script serves canned auth/threads frames and a
 * partial NDJSON stream (without the `done` frame, so the stream stays open)
 * via Playwright route interception. Output is written to
 * docs/screenshots/job159/.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, "..");
const outDir = path.join(dashboard, "docs", "screenshots", "job159");
const PORT = 5179;
const BASE = `http://localhost:${PORT}`;

/** Playwright lives in the npx cache — a bare require("playwright") fails. */
const requireFrom = createRequire("/home/kspviswa/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/package.json");
const { chromium } = requireFrom("playwright");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startVite() {
  const child = spawn("./node_modules/.bin/vite", ["--port", String(PORT), "--strictPort", "--logLevel", "error"], {
    cwd: dashboard,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let first = "";
  child.stdout.on("data", (chunk) => {
    first += String(chunk);
  });
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/index.html`);
      if (res.ok) return child;
    } catch {
      /* server not up yet */
    }
    await sleep(250);
  }
  child.kill("SIGTERM");
  throw new Error(`vite never came up: ${first}`);
}

/** Fulfil a JSON API call. */
function jsonApi(payload, status = 200) {
  return (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

/**
 * A NDJSON stream that never sends `done` — the turn stays streaming, so the
 * red Stop stays on screen for the screenshot.
 */
const ANSI = (lines) => `${lines.join("\n")}\n`;
const STREAM = ANSI([
  JSON.stringify({ type: "init" }),
  JSON.stringify({ type: "phase", data: { phase: "researching" } }),
  JSON.stringify({
    type: "step",
    data: { kind: "reasoning", reasoning: "Planning the search…" },
  }),
  JSON.stringify({
    type: "sources",
    data: [
      { idx: 1, title: "Paris - Wikipedia", url: "https://en.wikipedia.org/wiki/Paris", domain: "en.wikipedia.org" },
    ],
  }),
  JSON.stringify({ type: "response", data: "Paris is the capital of France. It sits on the Seine" }),
]);

async function stubCommon(context) {
  await context.route("**/api/auth/me", jsonApi({}));
  await context.route("**/api/auth/commands*", jsonApi({ commands: [] }));
  await context.route("**/api/ask/threads*", jsonApi({ threads: [] }));
  await context.route("**/api/ask/groups*", jsonApi({ groups: [] }));
}

async function desktop(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => localStorage.setItem("sarathy_token", "job159"));
  await stubCommon(context);

  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByTestId("nav-ask").click();
  await page.getByTestId("ask-query").waitFor();
  await page.getByTestId("ask-query").fill("What is the capital of France?");
  await sleep(400);
  await page.screenshot({ path: path.join(outDir, "ask-desktop-idle.png") });

  // Streaming: fulfil the run with a stream that has no `done` frame.
  await context.route("**/api/ask", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: STREAM });
  });
  await page.getByTestId("ask-submit").click();
  await page.getByTestId("ask-stop").waitFor();
  await sleep(900);
  await page.screenshot({ path: path.join(outDir, "ask-desktop-streaming.png") });

  await context.close();
}

async function mobile(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  await context.addInitScript(() => localStorage.setItem("sarathy_token", "job159"));
  await stubCommon(context);

  const page = await context.newPage();
  await page.goto(`${BASE}/mobile.html`, { waitUntil: "networkidle" });
  await page.getByTestId("mobile-tab-ask").click();
  await page.getByTestId("ask-query").waitFor();
  await page.getByTestId("ask-query").fill("What is the capital of France?");
  await sleep(400);
  await page.screenshot({ path: path.join(outDir, "ask-mobile.png") });

  await context.close();
}

const server = await startVite();
try {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  await desktop(browser);
  await mobile(browser);
  await browser.close();
  console.log("WROTE", outDir);
} finally {
  server.kill("SIGTERM");
}
