# Dashboard — rules for coding agents

Read this before touching anything under `dashboard/src`.

## SPA parity (HARD RULE — no exceptions)

There are **two SPAs** and they are one product:

| Shell   | Entry                | Shell chrome |
| ------- | -------------------- | ------------ |
| desktop | `src/App.tsx`        | `src/views/*` |
| mobile  | `src/mobile/App.tsx` | `src/mobile/*` |

**Every change applies to BOTH shells in the SAME commit.** A change that
lands in one shell and not the other is an incomplete change, not a follow-up.

### How to do it — one declaration, two arrangements

Shared behaviour lives in ONE module that both shells import. Never copy a
component into the mobile tree so it can be "tweaked".

When one component must serve both shells, it takes `variant` and the variant
may change **only the arrangement**: the container's direction, spacing, and
the size of a field. It must never re-declare a control.

```tsx
// ✅ right — declared once, placed twice
const submitControl = <Button data-testid="ask-submit" … />;
const controlsRow = <div data-testid="ask-controls-row">{sources}{mode}{streaming ? stop : submitControl}</div>;
const inputRow = <div className={isMobile ? "flex flex-col gap-1" : "flex items-end gap-2"}>{queryField}{controlsRow}</div>;

// ❌ wrong — the same control written in each branch; a fix to one misses the other
const desktopRow = <div>…<Button data-testid="ask-submit" …/></div>;
const mobileRow  = <div>…<Button data-testid="ask-submit" …/></div>;
```

Duplicated markup is the drift vector that hid the mobile Ask composer defects
for weeks (wrong input size, non-red stop in the wrong place). It is now
**mechanically blocked**: `scripts/check-spa-parity.mjs` fails the build when a
`variant`-branching file declares the same `data-testid` or static
`aria-label` twice. It runs on `prebuild` and `pretest`.

### Mobile-specific constraints (learned the hard way)

- **Inputs must be ≥ 16px (`text-base`).** iOS Safari auto-zooms the whole
  page on focus below that — the user reads it as "the screen jumps and zooms".
- **Never put a fallback viewport unit after the modern one.** `height: 100vh`
  then `height: 100dvh` — the later declaration wins, so write the fallback
  first. `100vh` on iOS is the *largest* viewport, so the app becomes taller
  than the visible area and the page scrolls under it.
- **Respect the safe area** (`env(safe-area-inset-*)`), and test at 320–430px.
- **The stop/cancel control is destructive and round**, in the same slot as
  submit — never a stray outline button at the end of a wrapping row.

## Verification (required before you claim done)

1. `npm run check:spa-parity` — passes.
2. `npm test` — passes; add a test for a new behaviour, and a parity test when
   a shared component gains a variant.
3. `npm run build`.
4. **Walk the real flow in BOTH shells** at the live URL — desktop 1280–1440,
   mobile 390 (touch emulation). A green test suite is not a substitute for
   looking at the rendered page; the composer defects above passed every test
   that existed at the time.

## Other standing rules

- Shared logic goes in `src/lib/` — if two files need it, it moves there.
- No new runtime dependency without asking.
- Commit AND push to `origin/main` in the same session as the change.
