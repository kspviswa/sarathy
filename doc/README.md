# Sarathy Engineering — the book

This directory holds the **sources** of *Sarathy Engineering*, a Quarto book about
the architecture, patterns and engineering decisions behind Sarathy.

| | |
|---|---|
| Sources | `doc/*.qmd`, `doc/chapters/*.qmd` |
| Book config | `doc/_quarto.yml` |
| Theme | `doc/brand.yml` (colours), `doc/styles.css` (small overrides) |
| **Rendered site** | **`docs/` at the repository root** — the deliverable, and what GitHub Pages publishes |
| Build tool | the local `quarto` CLI, and nothing else |
| Smoke test | `python3 -m unittest discover tests -k book` |

## Build

From the repository root:

```bash
quarto render doc
```

That renders every `.qmd` into `docs/`, with all assets (Bootstrap, Quarto's own
JavaScript, the bundled MermaidJS, fonts) written next to the HTML under
`docs/site_libs/`. The result is a plain static site: no build step, no server-side
anything, and no external requests — open `docs/index.html` through any static file
server and it works offline.

```bash
python3 -m http.server -d docs 8000   # then browse to localhost:8000
```

> **Note.** `project.output-dir` points at `../docs`, which is *outside* the
> project directory. Quarto therefore refuses to pre-clean the output directory
> ("Refusing to remove directory … since it is not a subdirectory of the main
> project directory"). Delete `docs/` by hand when you want a pristine build.

> **Note on `embed-resources`.** It is deliberately **not** enabled. For a
> multi-page book it inlines each page's *neighbouring pages* as `data:` URIs, so
> page weight grows exponentially with chapter count — measured at 65 MB for the
> appendix before it was turned off, versus 42 KB after. Everything the pages need
> is a local relative file instead.

## Chapter layout

| File | Role |
|------|------|
| `index.qmd` | Cover: orientation, house rules, provenance, chapter map |
| `chapters/01-why-sarathy-exists.qmd` | Origin, the design constraints, what "local-first" means concretely, what the project is not |
| `chapters/02-architecture.qmd` | The gateway, the bus, the agent loop, tools, sessions, providers, dashboard, backend channel, state |
| `chapters/03-patterns.qmd` | Twelve named patterns, each with the invariant that keeps it honest |
| `chapters/04-decisions.qmd` | Eighteen decisions as situation / options / choice / cost |
| `engineering-log.qmd` | **Living page.** Dated, newest-first entries plus the entry template |
| `chapters/05-testing-and-ops.qmd` | Appendix: the test suite, isolation, verify-before-close, change taxonomy, restart and deploy discipline |

The chapter order is declared in `doc/_quarto.yml`. Adding a chapter means adding
its path there and re-rendering.

## Diagrams

**All diagrams are MermaidJS, authored as native Quarto `{mermaid}` executable
cells.** Nothing is hand-drawn SVG and nothing is hosted externally.

````markdown
```{mermaid}
%%| label: fig-something
%%| fig-cap: "What the reader should take away from this picture."
flowchart LR
  A[Start] --> B[End]
```
````

- Cell options use Mermaid's `%%|` comment syntax and must sit directly under the
  opening fence.
- Always give a diagram `label` and `fig-cap`. The caption is what a reader
  (and a future grep) gets; the label is what makes the diagram linkable.
- For HTML output Quarto bundles MermaidJS into the page and draws the diagram in
  the browser. No browser binary is needed at render time — Chrome is only
  required for print output formats.
- Diagram colour is themed through Quarto's CSS variables in `doc/styles.css`
  (`--mermaid-node-bg-color` and friends). Mermaid's own themes are available via
  `format.html.mermaid.theme` if you prefer them.

## Updating the Engineering Log {#log}

The Engineering Log is the mechanism that keeps the rest of the book true. To add
an entry:

1. Open `doc/engineering-log.qmd` and scroll to just under the
   `**Last entry:**` line, above the first dated entry.
2. Copy the template from the [Entry template](engineering-log.qmd#sec-log-template)
   section and paste it there. Keep the `**What changed.** / **Why.** /
   **Lesson / correction.** / **Where it lives.**` headings — the *lesson* is the
   part future readers care about.
3. Bump the `**Last entry:**` date and the `**Entries:**` count.
4. If the change contradicts anything in chapters 1–4, fix that chapter **in the
   same change**. A log entry that leaves the book contradicting itself is worse
   than no entry.
5. Re-render and re-run the smoke test.

Entries are written from evidence: the code, a commit, or an observable behaviour.
Entries whose "why" is only operational practice (rather than something the
repository shows) are marked `[ops]` so a reader can tell them apart.

## Sanitization rules {#sanitization}

**The book is public. These rules are absolute and they are enforced by the smoke
test, not by good intentions.** The test scans both the `.qmd` sources and the
rendered `.html`.

1. **No real personal names.** Write "the operator", "the author", "the user". The
   test also rejects any name declared in the package metadata, so the book cannot
   drift into naming its author.
2. **No identifiers.** No chat ids, no usernames or handles, no contact details,
   no long digit strings that could be one.
3. **No credentials.** No keys, no tokens, no credential-shaped strings, no
   credential *files*. Configuration is described by field name only, never by
   value.
4. **No private paths.** Every path is either repository-relative
   (`sarathy/agent/loop.py`) or workspace-relative (`workspace/sessions/`). Home
   directories are never spelled out.
5. **No private content.** Nothing is quoted from actual conversations, the memory
   store, or job records. The book describes mechanisms, never payloads.

If a pattern trips, fix the prose — do not weaken the pattern. If a rule genuinely
blocks something you need to say, say it in the most abstract terms available.

## Verification {#verify}

```bash
# rebuild
quarto render doc

# the gate: structure, links, well-formedness, diagrams, sanitization
python3 -m unittest discover tests -k book

# or just this file
python3 tests/test_book.py
```

The gate checks that:

- every required source and rendered page exists, and every `.qmd` has a page;
- every internal `href`/`src` in the rendered HTML resolves to a real file;
- every anchor fragment resolves to a real element id;
- every page parses with `html.parser` and has no unbalanced tags;
- every page contains at least one `{mermaid}` block in its source and the
  corresponding rendered diagram element, and the bundled MermaidJS assets exist;
- no page references a remote asset;
- no forbidden pattern appears in any source or rendered page, and no declared
  author name appears anywhere.

> **Environment note.** `python3` must be the interpreter that has `pytest`
> installed — normally the project virtual environment — because `unittest
> discover` imports every module under `tests/`, including the pytest-style ones.
> If `python3 -m unittest discover tests -k book` reports import errors for
> unrelated test modules, that is this, not the book.

## Conventions

- Line length in prose: wrap at ~85 characters; Markdown does the rest.
- British-ish spelling is already mixed in the codebase; be consistent within a
  chapter rather than globally.
- Cite code as `path/to/module.py` and symbols as `Class.method` in backticks.
- Cite commits by short hash only, in backticks.
- Prefer a table to a list when the reader is going to compare rows.