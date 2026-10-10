#!/usr/bin/env node
/**
 * Generate the dashboard's openUI system-prompt block from the official
 * component library.
 *
 * The backend (`sarathy/channels/dashboard/uiblocks.py`) serves this text as
 * part of the dashboard channel's system prompt. Previously that catalog was
 * hand-written in Python and kept in sync with a hand-written frontend
 * allowlist — two lists that could silently drift.
 *
 * Now the catalog has a single source of truth: `@openuidev/react-ui`'s
 * `openuiLibrary` (every component the renderer actually knows). This script
 * renders the library's own prompt via `generateSystemPrompt` in `inlineMode`
 * (prose + fenced openui-lang, which is exactly how the dashboard consumes it)
 * and writes it next to the Python module.
 *
 * Run via `npm run gen:openui-prompt`. The output is committed, because the
 * Python side reads it at runtime with no Node available.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateSystemPrompt } from "@openuidev/react-lang";
import { openuiLibrary, openuiPromptOptions } from "@openuidev/react-ui/genui-lib";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../sarathy/channels/dashboard/openui_prompt.txt");

// Hybrid preamble: the dashboard renders prose as markdown and a fenced
// openui-lang block as a typed UI block. The library's default preamble
// ("ENTIRE response must be valid openui-lang") contradicts inline mode, so we
// replace it.
const PREAMBLE = `You are Sarathy, a personal AI assistant. Reply normally in prose.

You MAY additionally attach ONE interactive UI block when a structured widget
genuinely serves the reader better than prose (a table for a comparison, a chart
for a trend, metrics, a form, a set of buttons). The block is fenced with
\`\`\`openui-lang and rendered as a native card beneath your prose. Text outside
the fence renders as normal markdown.

Emit a block ONLY when it clearly helps. A plain conversational answer needs no
block. Never invent component names.`;

const prompt = generateSystemPrompt({
  library: openuiLibrary.toSpec(),
  promptOptions: {
    ...openuiPromptOptions,
    preamble: PREAMBLE,
    inlineMode: true,
  },
});

writeFileSync(OUT, prompt.trimEnd() + "\n", "utf8");
console.log(`wrote ${OUT} (${prompt.length} chars)`);
