/**
 * Spec 175 — Playwright browser verification.
 * Captures screenshots + measurements into dashboard/artifacts/175/.
 */
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "artifacts", "175");
const BASE = process.env.VERIFY175_URL || "http://127.0.0.1:5179/verify175.html";

mkdirSync(OUT, { recursive: true });

/** Resolve any CSS color (oklch/oklab/rgb) to sRGB via canvas, then WCAG ratio. */
async function measureContrast(page, fgSelector, bgSelector) {
  return page.evaluate(
    ({ fgSelector, bgSelector }) => {
      const fgEl = document.querySelector(fgSelector);
      const bgEl = document.querySelector(bgSelector);
      if (!fgEl || !bgEl) return null;

      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d");

      const toRgba = (cssColor) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = cssColor;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };

      const fgCss = getComputedStyle(fgEl).color;
      const bgCss = getComputedStyle(bgEl).backgroundColor;
      const [fr, fg, fb, fa] = toRgba(fgCss);
      const [br, bg, bb] = toRgba(bgCss);
      // Composite translucent foreground over the bubble fill.
      const r = Math.round(fr * fa + br * (1 - fa));
      const g = Math.round(fg * fa + bg * (1 - fa));
      const b = Math.round(fb * fa + bb * (1 - fa));

      const lum = ([R, G, B]) => {
        const lin = [R, G, B].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      };
      const L1 = lum([r, g, b]);
      const L2 = lum([br, bg, bb]);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      return {
        fgCss,
        bgCss,
        fgRgb: [r, g, b],
        bgRgb: [br, bg, bb],
        ratio,
      };
    },
    { fgSelector, bgSelector },
  );
}

const measurements = {};

const browser = await chromium.launch({ headless: true });
const desktop = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 1,
});
const page = await desktop.newPage();
await page.goto(BASE, { waitUntil: "networkidle" });

async function shot(name, selector) {
  const el = page.locator(selector);
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await el.screenshot({ path: join(OUT, name) });
  console.log("shot", name);
}

// 01 greeting
await shot("01-greeting.png", '[data-testid="scene-greeting"]');
const chipLabels = await page.locator('[data-testid="suggestion-chip"]').allTextContents();
const bad = chipLabels.filter((l) => /^\[|Runtime Context|^\/home\//.test(l));
measurements.chipLabels = chipLabels;
measurements.chipBadMatches = bad;
console.log("chips:", chipLabels, "bad:", bad);

// 02 quote bar
await page.locator('[data-testid="scene-quote-bar"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
// Recompute bar position after scroll (fixed coords are viewport-relative).
await page.evaluate(() => {
  const card = document.querySelector('[data-testid="quote-bar-card"]');
  const bar = document.querySelector('[data-testid="quote-action-bar"]');
  if (!card || !bar) return;
  const r = card.getBoundingClientRect();
  bar.style.top = `${Math.max(8, r.top + 8)}px`;
  bar.style.left = `${Math.max(8, r.left + 16)}px`;
});
await page.waitForTimeout(100);
await page.screenshot({
  path: join(OUT, "02-quote-bar.png"),
  clip: await page.locator('[data-testid="scene-quote-bar"]').boundingBox(),
});
console.log("shot 02-quote-bar.png");
const barContrast = await measureContrast(
  page,
  '[data-testid="quote-action-bar"]',
  '[data-testid="quote-action-bar"]',
);
measurements.quoteBar = barContrast;
console.log("quote bar contrast:", barContrast?.ratio?.toFixed(2));

// 03 composer
await shot("03-composer-preview.png", '[data-testid="scene-composer"]');
const hasStrong = await page
  .locator('[data-testid="scene-composer"] [data-testid="composer-markdown-preview"] strong')
  .count();
measurements.composerStrongCount = hasStrong;

// 04 user actions
await shot("04-user-actions.png", '[data-testid="scene-user-actions"]');
const actionContrast = await measureContrast(
  page,
  '[data-testid="scene-user-actions"] [data-testid="message-reply"]',
  '[data-testid="scene-user-actions"] .bg-primary',
);
measurements.userActionContrast = actionContrast;
console.log("user action contrast:", actionContrast);

// 05 thumbnail
await shot("05-thumbnail.png", '[data-testid="scene-thumbnail"]');
const thumbBox = await page.locator('[data-testid="chat-media-thumb"]').first().boundingBox();
measurements.thumbSize = thumbBox;

// 06 / 07 font
await shot("06-font-small.png", '[data-testid="scene-font-small"]');
await shot("07-font-large.png", '[data-testid="scene-font-large"]');
const fontSizes = await page.evaluate(() => {
  const small = document.querySelector(
    '[data-testid="scene-font-small"] [data-chat-body]',
  );
  const large = document.querySelector(
    '[data-testid="scene-font-large"] [data-chat-body]',
  );
  return {
    small: small ? getComputedStyle(small).fontSize : null,
    large: large ? getComputedStyle(large).fontSize : null,
  };
});
measurements.fontSizes = fontSizes;

// 08 / 09 ask alignment — measure content column x
await page.locator('[data-testid="scene-ask-before"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const beforeX = await page
  .locator('[data-testid="scene-ask-before"] [data-testid="ask-turn-content"]')
  .evaluate((el) => el.getBoundingClientRect().x);
await shot("08-ask-before-media.png", '[data-testid="scene-ask-before"]');

await page.locator('[data-testid="scene-ask-after"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const afterX = await page
  .locator('[data-testid="scene-ask-after"] [data-testid="ask-turn-content"]')
  .evaluate((el) => el.getBoundingClientRect().x);
await shot("09-ask-after-media.png", '[data-testid="scene-ask-after"]');
measurements.askContentX = { before: beforeX, after: afterX, delta: afterX - beforeX };
console.log("ask content x before/after:", beforeX, afterX, "delta", afterX - beforeX);

// 10 progress
await page.locator('[data-testid="scene-progress"]').scrollIntoViewIfNeeded();
await page.locator('[data-testid="ask-steps-toggle"]').click();
await page.waitForTimeout(200);
// scroll mid-list
await page.locator('[data-testid="ask-step-list"]').evaluate((el) => {
  el.scrollTop = el.scrollHeight * 0.4;
});
await page.waitForTimeout(150);
await shot("10-progress-expanded.png", '[data-testid="scene-progress"]');
const progressMeta = await page.evaluate(() => {
  const list = document.querySelector('[data-testid="ask-step-list"]');
  const toggle = document.querySelector('[data-testid="ask-steps-toggle"]');
  const cs = list ? getComputedStyle(list) : null;
  return {
    maxHeight: cs?.maxHeight,
    overflowY: cs?.overflowY,
    sticky: toggle ? getComputedStyle(toggle).position : null,
    bottomExists: !!document.querySelector('[data-testid="ask-steps-collapse-bottom"]'),
  };
});
measurements.progress = progressMeta;

// Mobile emulation
const mobile = await browser.newContext({
  ...devices["iPhone 12"],
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const mpage = await mobile.newPage();
await mpage.goto(BASE, { waitUntil: "networkidle" });

async function mshot(name, selector) {
  const el = mpage.locator(selector);
  await el.scrollIntoViewIfNeeded();
  await mpage.waitForTimeout(150);
  await el.screenshot({ path: join(OUT, name) });
  console.log("shot", name);
}

await mshot("11-mobile-greeting.png", '[data-testid="scene-mobile-greeting"]');
await mshot("12-mobile-composer.png", '[data-testid="scene-mobile-composer"]');
await mshot("13-mobile-user-bubble.png", '[data-testid="scene-mobile-user-bubble"]');

writeFileSync(join(OUT, "measurements.json"), JSON.stringify(measurements, null, 2));
console.log("\nMeasurements written to", join(OUT, "measurements.json"));
console.log(JSON.stringify(measurements, null, 2));

await browser.close();

if (bad.length) {
  console.error("FAIL: bad chip labels", bad);
  process.exit(1);
}
if (Math.abs(afterX - beforeX) > 1) {
  console.error("FAIL: ask content x shifted", beforeX, afterX);
  process.exit(1);
}
if (actionContrast && actionContrast.ratio < 3) {
  console.error("FAIL: user action contrast < 3", actionContrast.ratio);
  process.exit(1);
}
if (barContrast && barContrast.ratio < 3) {
  console.error("FAIL: quote bar contrast < 3", barContrast.ratio);
  process.exit(1);
}
console.log("\n✓ verify175 passed");
