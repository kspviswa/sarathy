/**
 * Spec 176 — Playwright verification against the REAL dashboard shell.
 *
 * Serves sarathy/channels/dashboard/static/ (built bundle), mocks API/WS so
 * auth succeeds, injects sample bubbles, then captures screenshots +
 * measurements into dashboard/artifacts/176/.
 *
 * Does NOT use verify175.html or any synthetic harness page.
 */
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = join(ROOT, "../sarathy/channels/dashboard/static");
const OUT = join(ROOT, "artifacts", "176");
const PORT = Number(process.env.VERIFY176_PORT || 5176);

mkdirSync(OUT, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function serveStatic() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/" || pathname === "/dashboard" || pathname === "/dashboard/") {
        pathname = "/index.html";
      }
      if (pathname === "/mobile" || pathname === "/mobile/" || pathname === "/dashboard/mobile") {
        pathname = "/mobile.html";
      }
      // Strip leading /dashboard if present (some deploys nest under it).
      if (pathname.startsWith("/dashboard/")) {
        pathname = pathname.slice("/dashboard".length);
      }
      const filePath = join(STATIC, pathname.replace(/^\//, ""));
      if (!filePath.startsWith(STATIC) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const body = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(body);
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

function json(route, payload, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function installApiMocks(page) {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/api/auth/me")) return json(route, { ok: true, deviceName: "verify176" });
    if (url.includes("/api/auth/pair")) {
      return json(route, { token: "verify176-token", deviceName: "verify176" });
    }
    if (url.includes("/api/auth/logout")) return json(route, { ok: true });
    if (url.includes("/api/commands")) return json(route, { commands: [] });
    if (url.includes("/api/sessions")) return json(route, { sessions: [] });
    if (url.includes("/api/session/footer")) {
      return json(route, {
        sessionKey: "dashboard:console",
        tokens: 0,
        tokensPerSec: 0,
        cost: null,
        topic: null,
        contextUsedTokens: null,
        contextLength: null,
        contextPct: null,
        model: null,
        provider: null,
        messageCount: 0,
      });
    }
    if (url.includes("/api/notifications")) return json(route, { enabled: false });
    if (url.includes("/api/chat") && method === "POST") return json(route, { ok: true });
    if (url.includes("/api/config")) {
      return json(route, { agents: { defaults: { model: "llama3", provider: "ollama" } } });
    }
    if (url.includes("/api/providers")) return json(route, { providers: [], active: "" });
    if (url.includes("/api/modalities")) {
      return json(route, {
        main: { provider: "", model: "" },
        local: { provider: "", model: "" },
        image: { provider: "", model: "" },
        active: "",
      });
    }
    if (url.includes("/api/usage")) return json(route, { available: false });
    if (url.includes("/api/devices")) return json(route, { devices: [] });
    if (url.includes("/api/ask/threads") || url.includes("/api/ask/groups")) {
      return json(route, url.includes("groups") ? { groups: [] } : { threads: [] });
    }
    if (url.includes("/api/status")) {
      return json(route, {
        version: "0.0.0-verify",
        gateway: { running: true },
        channels: [],
        dashboard: { host: "127.0.0.1", port: PORT, streaming: true, pairingKeyCount: 0 },
      });
    }
    if (url.includes("/api/ask")) {
      return route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: "",
      });
    }
    return json(route, { ok: true });
  });

  // Let WS fail softly — chat still mounts; we inject bubbles for screenshots.
  await page.route("**/ws**", (route) => route.abort());
}

async function seedAuth(page) {
  await page.addInitScript(() => {
    localStorage.setItem("sarathy_token", "verify176-token");
    localStorage.removeItem("sarathy_chat_font_scale");
    localStorage.removeItem("sarathy_composer_font_scale");
    localStorage.removeItem("sarathy_app_font");
    localStorage.removeItem("sarathy_composed_font");
  });
}

async function injectChatBubbles(page) {
  await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="chat-view"] .relative .overflow-y-auto, [data-testid="mobile-chat"] .overflow-y-auto');
    const host =
      scroll ||
      document.querySelector('[data-testid="chat-view"]') ||
      document.querySelector('[data-testid="mobile-chat"]');
    if (!host) throw new Error("chat host missing");
    // Clear greeting if present.
    const greeting = host.querySelector('[data-testid="greeting-state"]');
    if (greeting) greeting.remove();

    const mk = (role, text) => {
      const row = document.createElement("div");
      row.setAttribute("data-testid", role === "user" ? "message-row-user" : "message-row-assistant");
      row.className = `group flex ${role === "user" ? "justify-end" : "justify-start"}`;
      const bubble = document.createElement("div");
      bubble.setAttribute("data-chat-body", "");
      bubble.setAttribute("data-testid", role === "user" ? "verify-user-bubble" : "verify-assistant-bubble");
      bubble.className =
        role === "user"
          ? "max-w-[85%] rounded-2xl px-4 py-2 bg-primary text-primary-foreground text-[15px] leading-relaxed"
          : "max-w-[85%] rounded-2xl px-4 py-2.5 border border-border bg-card text-card-foreground text-[15px] leading-relaxed";
      const md = document.createElement("div");
      md.className = "md";
      md.textContent = text;
      bubble.appendChild(md);
      row.appendChild(bubble);
      return row;
    };

    const wrap = document.createElement("div");
    wrap.setAttribute("data-testid", "verify-bubbles");
    wrap.className = "flex flex-col gap-3 p-4";
    wrap.appendChild(mk("user", "Explain the lākāras in a short paragraph."));
    wrap.appendChild(
      mk(
        "assistant",
        "The lākāras are the ten tense-mood classes of Sanskrit verbs. Present, imperfect, aorist, perfect, and future each carry a distinctive stem.",
      ),
    );
    host.prepend(wrap);

    // Seed composer text for size shots.
    const ta =
      document.querySelector('[data-chat-composer=""]') ||
      document.querySelector("textarea");
    if (ta && "value" in ta) {
      ta.value = "Draft note: the **composer** scales independently of the transcript.";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

async function injectAskTurn(page) {
  await page.evaluate(() => {
    const turns = document.querySelector('[data-testid="ask-turns"]');
    if (!turns) throw new Error("ask-turns missing");
    turns.innerHTML = "";
    const article = document.createElement("article");
    article.setAttribute("data-testid", "ask-turn");
    article.className = "flex flex-col gap-4";
    article.innerHTML = `
      <div data-testid="ask-turn-content" class="flex min-w-0 w-full flex-col gap-4">
        <h2 data-testid="ask-turn-query" data-chat-body="" class="text-xl font-medium">Capital of France?</h2>
        <div data-testid="ask-answer" class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Answer</h3>
          <div data-chat-body="">
            <div data-testid="ask-answer-markdown" class="md">Paris is the capital of France.</div>
          </div>
        </div>
      </div>`;
    turns.appendChild(article);
  });
}

async function measure(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      fontSizePx: parseFloat(cs.fontSize),
    };
  }, selector);
}

async function clickTimes(page, testId, n) {
  for (let i = 0; i < n; i++) {
    await page.getByTestId(testId).click();
    await page.waitForTimeout(40);
  }
}

async function shot(page, name, selector) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  await el.screenshot({ path: join(OUT, name) });
  console.log("shot", name);
}

const measurements = {
  note: "Captured against real index.html / mobile.html from the built static bundle.",
};

const server = await serveStatic();
const browser = await chromium.launch({ headless: true });

try {
  // ── Desktop shell ─────────────────────────────────────────────────────
  const desktop = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await desktop.newPage();
  await seedAuth(page);
  await installApiMocks(page);

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 15000 });
  await injectChatBubbles(page);

  // Reset reading scale to 1 via control if needed.
  const resetBtn = page.getByTestId("chat-font-reset");
  if (await resetBtn.count()) await resetBtn.click();
  await page.waitForTimeout(100);

  const navSel = '[data-testid="nav-chat"]';
  const userSel = '[data-testid="verify-user-bubble"]';
  const asstSel = '[data-testid="verify-assistant-bubble"]';
  const composerSel = "[data-chat-composer]";

  measurements.at100 = {
    user: await measure(page, userSel),
    assistant: await measure(page, asstSel),
    nav: await measure(page, navSel),
  };
  await shot(page, "01-transcript-100.png", '[data-testid="chat-view"]');

  // Drive toward ~250% and ~400% for screenshots (8× and more A+).
  // 1.1^9 ≈ 2.36, 1.1^14 ≈ 3.80
  await clickTimes(page, "chat-font-increase", 9);
  measurements.after9plus = {
    user: await measure(page, userSel),
    assistant: await measure(page, asstSel),
    nav: await measure(page, navSel),
    readout: await page.getByTestId("chat-font-reset").textContent(),
  };
  await shot(page, "02-transcript-250.png", '[data-testid="chat-view"]');

  await clickTimes(page, "chat-font-increase", 5);
  measurements.after14plus = {
    user: await measure(page, userSel),
    assistant: await measure(page, asstSel),
    nav: await measure(page, navSel),
    readout: await page.getByTestId("chat-font-reset").textContent(),
  };
  await shot(page, "03-transcript-400.png", '[data-testid="chat-view"]');

  // Spec §D21: 8 A+ and 8 A− from 1.0
  await page.getByTestId("chat-font-reset").click();
  await page.waitForTimeout(80);
  const at1 = {
    user: await measure(page, userSel),
    assistant: await measure(page, asstSel),
    nav: await measure(page, navSel),
  };
  await clickTimes(page, "chat-font-increase", 8);
  const after8plus = {
    user: await measure(page, userSel),
    assistant: await measure(page, asstSel),
    nav: await measure(page, navSel),
  };
  await clickTimes(page, "chat-font-decrease", 8);
  const after8minus = {
    user: await measure(page, userSel),
    assistant: await measure(page, asstSel),
    nav: await measure(page, navSel),
  };
  measurements.scaleRoundTrip = { at1, after8plus, after8minus };
  measurements.navUnchanged =
    at1.nav?.fontSize === after8plus.nav?.fontSize &&
    at1.nav?.fontSize === after8minus.nav?.fontSize;

  // Composer size — reset reading, shrink/grow composer only.
  await page.getByTestId("chat-font-reset").click();
  const bubbleBeforeComposer = await measure(page, userSel);
  await clickTimes(page, "composer-font-decrease", 4);
  measurements.composerSmall = {
    textarea: await measure(page, composerSel),
    bubble: await measure(page, userSel),
  };
  await shot(page, "04-composer-small.png", '[data-testid="composer-format-toolbar"]');
  // Also capture the textarea area.
  await shot(page, "04-composer-small-field.png", composerSel);

  await page.getByTestId("composer-font-reset").click();
  await clickTimes(page, "composer-font-increase", 10);
  measurements.composerLarge = {
    textarea: await measure(page, composerSel),
    bubble: await measure(page, userSel),
  };
  await shot(page, "05-composer-large.png", '[data-testid="chat-view"]');
  measurements.composerDoesNotAffectBubbles =
    bubbleBeforeComposer?.fontSize === measurements.composerLarge.bubble?.fontSize;

  // Appearance
  await page.getByTestId("nav-settings").click();
  await page.waitForSelector('[data-testid="settings-view"]');
  await page.getByTestId("settings-segment-appearance").click();
  await page.waitForSelector('[data-testid="settings-appearance"]');
  await shot(page, "06-appearance-default.png", '[data-testid="settings-appearance"]');

  await page.getByTestId("appearance-load-fonts").click();
  await page.waitForTimeout(500);
  const fallbackNote = await page.getByTestId("appearance-fallback-note").count();
  const systemNote = await page.getByTestId("appearance-system-note").count();
  let localFontCount = null;
  let localFontError = null;
  try {
    localFontCount = await page.evaluate(async () => {
      if (typeof window.queryLocalFonts !== "function") {
        return { available: false, count: 0, reason: "queryLocalFonts not a function" };
      }
      try {
        const fonts = await window.queryLocalFonts();
        const set = new Set(fonts.map((f) => f.family));
        return { available: true, count: set.size };
      } catch (e) {
        return { available: true, count: 0, reason: String(e) };
      }
    });
  } catch (e) {
    localFontError = String(e);
  }
  measurements.queryLocalFonts = localFontCount;
  measurements.queryLocalFontsError = localFontError;
  measurements.appearanceSource = systemNote
    ? "system"
    : fallbackNote
      ? "fallback"
      : "unknown";

  await shot(page, "07-appearance-fonts-loaded.png", '[data-testid="settings-appearance"]');

  // Pick a font from the list (fallback or system).
  await page.getByTestId("appearance-app-font-trigger").click();
  await page.waitForTimeout(200);
  // Prefer Arial if present, else first non-default option.
  const appOption = page.locator('[data-testid="appearance-app-font-option"]').filter({ hasText: "Arial" }).first();
  if (await appOption.count()) {
    await appOption.click();
  } else {
    const any = page.locator('[data-testid="appearance-app-font-option"]').first();
    if (await any.count()) await any.click();
    else await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(200);
  measurements.appFontNav = await measure(page, navSel);
  await shot(page, "08-app-font-applied.png", '[data-testid="settings-appearance"]');

  await page.getByTestId("appearance-composed-font-trigger").click();
  await page.waitForTimeout(200);
  const composedOption = page
    .locator('[data-testid="appearance-composed-font-option"]')
    .filter({ hasText: "Georgia" })
    .first();
  if (await composedOption.count()) {
    await composedOption.click();
  } else {
    const any = page.locator('[data-testid="appearance-composed-font-option"]').first();
    if (await any.count()) await any.click();
    else await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(200);
  await shot(page, "09-composed-font-applied.png", '[data-testid="settings-appearance"]');

  // Ask surface with reading scale
  await page.getByTestId("nav-chat").click();
  await page.waitForSelector('[data-testid="chat-view"]');
  await page.getByTestId("chat-font-reset").click();
  await clickTimes(page, "chat-font-increase", 8);
  await page.getByTestId("nav-ask").click();
  await page.waitForSelector('[data-testid="ask-surface"]');
  await injectAskTurn(page);
  measurements.askScaled = {
    query: await measure(page, '[data-testid="ask-turn-query"]'),
    answer: await measure(page, '[data-testid="ask-answer-markdown"]'),
    nav: await measure(page, navSel),
  };
  await shot(page, "10-ask-transcript-scaled.png", '[data-testid="ask-surface"]');

  // Capture composed font on a bubble after returning to chat.
  await page.getByTestId("nav-chat").click();
  await page.waitForSelector('[data-testid="chat-view"]');
  await injectChatBubbles(page);
  measurements.composedFontBubble = await measure(page, userSel);

  await desktop.close();

  // ── Mobile shell ──────────────────────────────────────────────────────
  const mobile = await browser.newContext({
    ...devices["iPhone 12"],
    viewport: { width: 390, height: 844 },
  });
  const mpage = await mobile.newPage();
  await seedAuth(mpage);
  await installApiMocks(mpage);
  await mpage.goto(`http://127.0.0.1:${PORT}/mobile.html?view=mobile`, {
    waitUntil: "networkidle",
  });
  await mpage.waitForSelector('[data-testid="mobile-chat"]', { timeout: 15000 });
  await injectChatBubbles(mpage);
  await mpage.getByTestId("chat-font-reset").click();
  await clickTimes(mpage, "chat-font-increase", 8);
  measurements.mobileScaled = {
    user: await measure(mpage, userSel),
    nav: await measure(mpage, '[data-testid="mobile-tab-chat"], [data-testid="mobile-nav-chat"]'),
  };
  await shot(mpage, "11-mobile-transcript-scaled.png", '[data-testid="mobile-chat"]');

  // Mobile appearance
  await mpage.getByTestId("mobile-tab-settings").click();
  await mpage.waitForSelector('[data-testid="settings-view"]');
  await mpage.getByTestId("settings-segment-appearance").click();
  await mpage.waitForSelector('[data-testid="settings-appearance"]');
  await shot(mpage, "12-mobile-appearance.png", '[data-testid="settings-appearance"]');

  // Also verify 320px briefly.
  await mpage.setViewportSize({ width: 320, height: 700 });
  await mpage.waitForTimeout(200);
  measurements.mobile320 = {
    appearanceVisible: await mpage.getByTestId("settings-appearance").isVisible(),
    loadFontsHeight: await mpage.getByTestId("appearance-load-fonts").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    }),
  };

  await mobile.close();
} finally {
  await browser.close();
  server.close();
}

writeFileSync(join(OUT, "measurements.json"), JSON.stringify(measurements, null, 2));
console.log("wrote", join(OUT, "measurements.json"));
console.log(JSON.stringify(measurements, null, 2));
