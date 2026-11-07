# Spec — Voice Mode (dashboard, single job)

> _This is the single source of truth for this job. One spec per job. If the job is not
> complete and needs another run, UPDATE this spec (advance the Progress Tracker below) and
> rerun the SAME job — do not fork a new spec._
>
> _Register with jobctl FIRST, then fill in the id:_
> `jobctl create --kind sdd --backend opencode --title "Voice mode: duplex voice tab in dashboard" --repo /home/kspviswa/ws/sarathy --model big-pickle --spec jobs/specs/173.md --source-session "telegram:5878545507"`
>
> **Status:** planned (registered as job 173, not launched) · spec rev 2 (2026-11-07: ASR = Shruti-Tamil) · **Date:** 2026-11-07 · **Author:** Sarathy
> **Not launched.**

---

## 1. Goal

Add a third tab, **Voice**, beside Chat and Ask in the Sarathy dashboard. Tapping it
opens an explicit Activate button; activating loads a local TTS engine and a local
STT model, then opens a duplex voice channel where Viswa speaks freely and Sarathy
answers **spoken aloud as the text streams** — not as a voice note file.

Everything runs locally on this box. No cloud STT, no cloud TTS, no ffmpeg in the
voice path. The session is isolated under its own channel namespace and appears in
the existing calendar history.

**Repo:** `/home/kspviswa/ws/sarathy`
**Touches:** `dashboard/` (both SPAs), `sarathy/channels/dashboard/server.py`,
`sarathy/session/`, new `sarathy/voice/`.

---

## 2. Context / Current State

### 2.1 What exists and is reused

| Capability | Where |
|---|---|
| Mic capture, `MediaRecorder` | `dashboard/src/views/ChatView.tsx`, `dashboard/src/mobile/ChatView.tsx` |
| Audio playback, `AudioContext` + analyser | same files |
| Text streaming to client (`_progress` frames) | `DashboardChannel.send()` in `sarathy/channels/dashboard/server.py` |
| Turn control (`/stop`, `/steer`) | `sarathy/agent/loop.py` |
| Local TTS (Woof, numpy) | `~/ws/woof-sample/underdog-woof` |
| Local STT (Shruti-Tamil, Cactus engine) | `~/.sarathy/models/shruti/shruti-tamil.cact` |
| Markdown → speakable stripping | `~/portals/shravana/stripper.py` |
| Session index + calendar | `sarathy/session/manager.py`, `dashboard/src/views/SessionsView.tsx` |

### 2.2 Measured on this box (aarch64, 4 vCPU, CPU only) — 2026-11-07

| Stage | Measured |
|---|---|
| Woof model load | 0.119 s |
| Woof time-to-first-audio (first sentence) | 0.193 s |
| Woof steady-state RTF | 0.115 (8.7× realtime) |
| Shruti-Tamil model load (warm) | 0.10 s |
| Shruti-Tamil, 10.16 s Tamil utterance | 0.19 s — RTF 0.019 (52× realtime) |
| Shruti-Tamil, 5.59 s English utterance | 0.045 s — RTF 0.008 (125× realtime) |
| Shruti-Tamil peak RSS | 105 MB |
| _for comparison_ faster-whisper `base` int8, same 10.16 s Tamil clip | 11.24 s — RTF 1.106 (0.9×, slower than realtime) |
| _for comparison_ faster-whisper `base` int8 peak RSS | 509 MB |

**Voice mode uses Shruti-Tamil, not Whisper.** On the same Tamil clip Whisper was
slower than realtime and produced mangled text (`கடந்தனிதையாண்டில் வங்கியின
மத்தலாபம்…`); Shruti was 59× faster and near-verbatim. On mixed Tamil+English,
Whisper detected `en` and silently dropped the entire Tamil portion; Shruti
transcribed both. Shruti also uses 5× less memory — which matters, because Woof and
the STT model are resident together for the whole session.
`faster-whisper small` stays the model for long Telegram voice notes, where
throughput does not matter and punctuation does.

Woof's RTF is load-bearing: synthesis outruns playback 8.7×, so a sentence-per-sentence
queue drains faster than it fills. Long answers are safe.

### 2.3 Safari native transcription — rejected, with reasons

Viswa suggested using iOS/macOS built-in transcription, possibly client-side. It is
reachable from web clients (`webkitSpeechRecognition`, Safari 14.1+ / iOS 14.5+), but
it cannot be the foundation:

1. WebKit's own tracker (Documentation#120) documents `interimResults` unpredictably
   **switching to cloud-based recognition** mid-session; the reporter confirmed by
   killing the network, after which recognition failed outright.
2. `continuous = true` on iPhone keeps the mic open and **never returns final text**.
3. The on-device `SpeechAnalyzer` (WWDC25) is a Swift framework, **not exposed to the web**.
4. The dashboard is a standalone PWA (`apple-mobile-web-app-capable`), where iOS speech
   recognition is widely reported broken.
5. `lang` only — no vocabulary hints for names or part numbers.

**Use local Shruti-Tamil.** One model, one transcript, every device, audio never
leaves the box. It is 29.7 MB (a single `.cact` file), Apache-2.0, and covers the
Tamil + English + code-mixed speech this household actually produces — Whisper does
not.

### 2.4 Known traps to handle

- **iOS audio routing:** a live `getUserMedia` stream routes playback to the earpiece
  at low volume unless `navigator.audioSession.type = "play-and-record"` (Safari 17.4+,
  not Baseline). Reset to `"auto"` on exit.
- **Echo:** speaker output re-enters the mic and the VAD reads it as speech. Requires
  AEC + a sustained-energy threshold for barge-in.
- **Residency:** constructing the STT engine per invocation wastes 0.1-1.6 s per turn.
  Voice mode must hold one instance for the session lifetime, and release it on End
  Session.
- **Shruti packaging trap:** the model card says `pip install cactus-needle`, but that
  package is stale — it fetches native engine wheels from
  `Cactus-Compute/needle3/python/*.whl`, which 404 on **every** platform (verified
  aarch64, x86_64, macOS arm64). The working package is **`cactus-compute` 4.0.1**
  from PyPI, imported as `from cactus import Whistle`. Pin it; do not follow the card.
- **Shruti output shape:** returns a dict — `{text, language, ttft_ms, decode_tps}`.
  `text` has **no punctuation** and spells numbers as words ("twelve percent", not
  "12%"). This is documented behaviour, not a bug. Do not "fix" it by post-processing;
  the LLM reads it fine. Tamil comes back in Tamil script, English words in lowercase
  Latin, code-mixed in one string.
- **Shruti audio contract:** 16 kHz mono, 16-bit PCM in. The browser captures at
  48 kHz — the server must resample before calling `transcribe()`. `transcribe()`
  accepts a WAV path or a float32 numpy array.

---

## 3. Requirements

### A. Transport — new `/ws/voice`

- New authenticated WebSocket endpoint `/ws/voice` on the dashboard server. **Do not
  modify `/ws`** — its frame contract (spec 126/127/128) must stay untouched.
- Auth: same device-token path as `/ws` (`?token=` on the upgrade URL, same
  `_check_auth`).
- JSON control frames plus **binary audio frames in both directions**.
- Server → client binary frames are **raw Int16 PCM, 24 kHz, mono**. Client → server
  binary frames are **raw Int16 PCM, 16 kHz, mono**. No WAV, no OGG, no MP3, **no
  ffmpeg anywhere in the voice path**.
- Server-side writer must handle backpressure and sequencing; a slow client must not
  grow an unbounded queue — drop oldest audio and emit a `state` correction.

Client → server frames:

| Frame | Payload | Meaning |
|---|---|---|
| `hello` | `{token}` | handshake (or `?token=`) |
| `start` | `{voice: "juno", stt: "shruti-tamil"}` | begin activation; triggers warm-up |
| `cancel` | `{reason}` | abort activation **or** end a live session |
| `speech_start` | `{ts}` | VAD onset — barge-in signal |
| `speech_end` | `{ts}` | VAD end; utterance complete |
| *binary* | Int16 PCM 16 kHz mono | microphone audio |
| `stop_turn` | `{}` | interrupt the current answer only, stay live |

Server → client frames:

| Frame | Payload | Meaning |
|---|---|---|
| `prep` | `{step, status, ms}` | one prep step → `running`/`done`/`failed` |
| `ready` | `{voice, stt, session_id, prep_ms}` | warm-up done — play the chime |
| `state` | `{state}` | `listening` / `thinking` / `speaking` / `idle` |
| `partial` | `{text, is_final}` | live transcript |
| `text` | `{delta}` | answer text as it arrives |
| `tool` | `{name, hint}` | a tool started — drives the thinking UI |
| *binary* | Int16 PCM 24 kHz mono | answer audio — play immediately |
| `sentence_end` | `{seq}` | boundary of one synthesized sentence |
| `done` | `{turn_id}` | turn complete |
| `ended` | `{session_id, reason}` | session torn down, resources released |
| `error` | `{code, message, recoverable}` | surfaced in the UI |

### B. Synthesis — streaming TTS

> **⚠ TTS ENGINE UNDER REVISION (2026-11-07).** This section is written against Woof,
> which is measured and working. Viswa has ported **Maya-2-Native to CPU** and will
> supply the repo. When that lands, swap the engine behind the same interface — the
> streaming contract below (stripper → sentence splitter → ordered PCM) is
> engine-agnostic and must not change. Do not start B until the Maya repo is in hand
> and the engine choice is settled; A, C, D, E and G are unaffected.

- Woof singleton with explicit `load()` / `unload()`. Voice **Juno**, fixed. No picker.
- Hook `DashboardChannel.send()` where `_progress` frames carry **accumulated** answer
  text; diff against what has already been emitted.
- Strip markdown **before** speaking: fenced code, tables, openUI blocks, URLs, citation
  markers, and the trailing topic machine-line. Reuse `~/portals/shravana/stripper.py`
  rules — do not reimplement them.
- Split into **sentences**, not paragraphs. Paragraph granularity destroys the 193 ms
  TTFA advantage.
- Synthesis worker pushes PCM frames to A in order; audio for sentence *n* never
  precedes sentence *n-1*.
- **Never speak tool chatter.** `_tool_hint` frames and "let me check" prose are
  suppressed.
- **Spoken filler on the first tool call of a turn** ("one moment, sir") so a 3-8 s web
  search is never silent.
- The voice hook must be **inert unless a voice session is live** — every dashboard turn
  flows through `send()`, so a bug here breaks normal chat.

### C. Session lifecycle

- State machine: `idle → preparing → live → unloading → idle`.
- `Cancel` (from `preparing`) and `error` both route through `unloading`. One teardown
  path, **idempotent**, tolerant of partial state (mic may be open while Woof is still
  loading).
- **Load on Activate, unload on End Session.** Never resident at gateway boot.
- Prep screen driven by real `prep` frames — no fake progress. Warm path is ~1-3 s; a
  first-ever run may download the Shruti model (~30 MB) and the `cactus-compute`
  engine, and must show a byte count, not a hang. Model lives at
  `~/.sarathy/models/shruti/shruti-tamil.cact`; if absent, fetch it from
  `udgamlabs/shruti-tamil` and report progress.
- Rising two-note chime on `ready`, synthesized with WebAudio oscillators in-page — no
  asset files. Mic opens automatically after the chime; no second tap.
- **Tab lock:** while `preparing` or `live`, navigation away is blocked. Clicking any
  other tab is a no-op with a brief shake and a one-line hint ("End the voice session
  first"). The only exits are the two buttons below.
- **Cancel** — visible during `preparing`. **End Session** — visible during `live`:
  large, red, bottom-centre, **slow pulsing glow** while live.
- **Crash safety:** a dropped WebSocket without `cancel` holds resources for a 30 s
  grace period, then unloads unconditionally. A dropped socket must never leave ~280 MB
  resident.

### D. Capture — mic, VAD, waveform

- `getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}})`.
- **`AudioWorklet`, not `MediaRecorder`** — VAD and streaming need raw samples;
  `MediaRecorder` gives compressed opaque chunks with 100 ms+ framing latency. Worklet
  decimates device rate → 16 kHz Int16.
- Silero VAD (ONNX, in-browser) emitting `speech_start` / `speech_end`. Zero added
  latency, audio never leaves the device until an utterance completes.
- `AnalyserNode` tap drives a live waveform — amplitude-driven bars, 60 fps, canvas.
- iOS: set `navigator.audioSession.type = "play-and-record"` on session start, reset to
  `"auto"` on exit.
- Client-side `AudioBufferSourceNode` scheduler with a running cursor for **gapless**
  playback of arbitrary PCM chunks.

### E. Recognition — live transcript

- Resident Shruti-Tamil (`cactus-compute` engine, CPU), loaded and released through
  C's lifecycle. Model path `~/.sarathy/models/shruti/shruti-tamil.cact`, overridable
  by env var `SHRUTI_MODEL`.
- Phrase commitment: VAD splits speech at short pauses (~350 ms); each completed phrase
  is transcribed immediately and appended, pushed as `partial` frames.
- Final utterance = committed phrases + one transcription of the trailing fragment.
- Transcript must appear **while the user is still speaking**, ~0.5 s behind the voice.

### F. Turn loop, sessions, history

- Session key: **`voice:<YYYYMMDD-HHMMSS>-<6char>`**, e.g. `voice:20261107-025412-a3f9c1`.
  One session per activation.
- **Never mingles** with `dashboard:console`, CLI, mail, or Telegram. Isolation is
  structural: session keys are `channel:chat_id` and `channel_for_key()` splits the
  prefix, so `voice:` is a new namespace — no filter to forget.
- Transcript → `AgentLoop.run()`; `_progress` / `_tool_hint` → B and the thinking UI.
- Thinking state reuses the existing cycling status line (`Searching the web…`,
  `Reading results…`, `Thinking…`). No new plumbing.
- **Barge-in:** 250 ms of **sustained** energy above threshold during playback. A single
  loud frame (cough, door, click) must not interrupt. On fire: stop every scheduled
  `AudioBufferSourceNode`, send `speech_start`, cancel the TTS queue, abort the turn,
  transition to `listening`.
- **History stores text only — no audio.** User turns = the committed transcript.
  Assistant turns = the **original LLM text, pre-strip and pre-synthesis**. Stripped
  markdown and TTS artifacts never enter the transcript. This needs an explicit test —
  the tempting shortcut is logging the spoken fragments.
- Calendar history comes free: `list_sessions()` reads the session index and
  `SessionCalendar` renders by date. Add `voice: Mic` to `CHANNEL_ICONS` in
  `dashboard/src/lib/channelIcons.tsx`.

### G. UI — Voice tab

- Third tab beside Chat and Ask: `{ id: "voice", label: "Voice" }` in `App.tsx`.
- **Idle screen:** centred orb, the word "Voice", one primary **Activate** button.
  Nothing loaded, no mic requested, no permission prompt until Activate is tapped. The
  Activate tap is also the iOS `AudioContext` unlock gesture.
- **Prep screen:** full-viewport panel, not a spinner. Four named steps going
  pending → running → done with real durations: text-to-speech engine, speech
  recognition, voice activity detector, opening audio channel. Cancel visible
  throughout.
- **Live:** waveform, live transcript, thinking status line, End Session button.
- **Ending:** brief "Closing session…", then back to `idle`.

### H. Tests (MANDATORY)

- Server: `/ws/voice` auth rejects a bad token; `start` → `prep` → `ready` sequence;
  `cancel` during prep releases resources (assert model unloaded); binary frame
  ordering; backpressure drop path.
- Synthesis: markdown stripper skips code/tables/URLs; sentence splitter emits complete
  sentences only; sentence *n* audio never precedes *n-1*.
- Lifecycle: teardown is idempotent — calling it twice is safe; Cancel at every prep
  step returns to `idle`; reaper unloads after a dropped socket.
- Sessions: `voice:` keys never collide with other namespaces; history stores original
  LLM text, not spoken fragments.
- Both SPAs: Activate → prep → live → End Session walk-through; tab lock blocks
  navigation and End Session is always reachable.
- Command: `python3 -m unittest discover tests` and `npm test` in `dashboard/`.
- All must be green before handoff.

### I. Both SPAs (MANDATORY — this job touches the dashboard)

- Read `dashboard/AGENTS.md` FIRST (SPA parity is a hard rule there).
- The dashboard is TWO SPAs — desktop (`src/App.tsx` + `src/views/*`) and mobile
  (`src/mobile/App.tsx` + `src/mobile/*`). They are ONE product.
- **Every change lands in BOTH shells in the SAME commit.** No "desktop first, mobile
  later".
- Shared behaviour lives in ONE module (`src/lib/`, `src/components/`); the mobile tree
  never gets a copy to tweak.
- A `variant`-branching component may change **only the arrangement** (container
  direction, spacing, field size). It must **never re-declare a control** — build the
  element once, place it in both branches. Duplicated markup is the drift vector.
- `npm run check:spa-parity` must pass (runs automatically on `prebuild`/`pretest`).
- Per requirement, state the DESKTOP and MOBILE outcome. A requirement with one outcome
  listed is incomplete.
- Mobile constraints: inputs ≥ 16px, fallback viewport unit written BEFORE the modern
  one (`100vh` then `100dvh`), safe-area insets respected, verified at 320-430 px width.
- Verification walks the real flow in BOTH shells (desktop 1280-1440, mobile 390 with
  touch emulation) — a green suite is not evidence for the rendered page.

---

## 4. Constraints (non-negotiable)

- Do **not** modify `/ws` or its frame contract. Voice gets its own endpoint.
- Do **not** make the voice hook fire for non-voice turns. It must be inert by default.
- Do **not** add ffmpeg, WAV, or OGG to the voice path. Raw PCM only.
- Do **not** use cloud STT or cloud TTS. Everything local.
- Do **not** load Woof or Shruti at gateway boot. Load on Activate, unload on End Session.
- Do **not** use `cactus-needle` — it is stale and its engine wheels 404. Use `cactus-compute`.
- Do **not** use `MediaRecorder` for capture. `AudioWorklet` only.
- Do **not** retain audio in session history. Text only.
- Do **not** invent progress. Every prep step must report real completion.
- Woof is **CC BY-NC 4.0** — personal use only. Kokoro (Apache 2.0) stays the default
  for anything client-facing.
- Woof has **two voices, English only**. No Hindi/Tamil/Tanglish. Do not attempt to
  make it speak them.
- Path scope: work only inside `/home/kspviswa/ws/sarathy` (plus reading
  `~/ws/woof-sample`, `~/.sarathy/workspace/voice`, `~/portals/shravana` for reuse).

---

## 5. Definition of Done (Acceptance Criteria)

- Tapping the Voice tab shows an Activate button; nothing is loaded until it is tapped.
- Activate shows a prep screen with four named steps and real durations, cancellable at
  any point.
- A chime plays on ready and the mic opens automatically — no second tap.
- Speaking produces a live waveform and a transcript that appears while the user is
  still talking.
- The answer is spoken aloud, starting within ~200 ms of the first sentence existing,
  with no gaps or clicks between chunks.
- Barge-in stops playback mid-sentence after 250 ms of sustained speech, and a cough
  does not.
- End Session releases Woof and Shruti; RSS returns to baseline. Verified by
  measurement, not by reading code.
- Navigation away is blocked while preparing or live; End Session is always reachable.
- A voice conversation appears in the calendar under a `voice:` session, showing the
  transcript and the original LLM text, with no audio retained.
- Both SPAs changed in the same commit; `npm run check:spa-parity` passes; the flow is
  verified live in both shells.
- Tests added and green.
- Handoff report written to `jobs/results/<id>.md`.

---

## 6. Validation / Handoff

- Paste `npm run check:spa-parity` output.
- Name what was observed in each shell — not "works" but "desktop: X, mobile 390px: Y".
- Report measured RSS before Activate and after End Session.
- Report measured time-to-first-audio for a real answer.
- Report the barge-in threshold actually used and confirm a cough does not trigger it.
- Confirm on iPhone that playback is not routed to the earpiece.
- Write handoff report to `jobs/results/<id>.md`: what changed, how each requirement was
  met, exact test command + output.

---

## 7. Progress Tracker (for resumed runs)

This job may run multiple times. Each run MUST first read this tracker, then resume
incomplete steps or redo failed ones. After each step mark it `[x] done` / `[~] blocked`
/ `[!] failed` with the current result-file timestamp. On a resumed run, do NOT redo
steps already `[x] done` unless their output was subsequently invalidated.

### Run 1 ({date}) — {FAILED / IN_PROGRESS / COMPLETED}

- [ ] A. `/ws/voice` transport, auth, binary frames both directions
- [ ] B. Woof singleton + stripper + sentence splitter + ordered PCM output
- [ ] C. State machine, prep frames, chime, tab lock, idempotent teardown, reaper
- [ ] D. AudioWorklet capture, Silero VAD, waveform, iOS audio session
- [ ] E. Resident Shruti-Tamil, phrase commitment, `partial` frames
- [ ] B is **blocked** pending the Maya-CPU TTS repo from Viswa
- [ ] F. `voice:` sessions, transcript/original-text history, barge-in, fillers
- [ ] G. Voice tab UI on BOTH SPAs
- [ ] H. Tests green (`python3 -m unittest discover tests`, `npm test`)
- [ ] I. `npm run check:spa-parity` + live verification in both shells

### ACs validated ({date})

- (none yet)

---

## 8. Out of scope

- Wake word ("hey Sarathy") — separate problem, and a privacy minefield.
- Telephony / PSTN.
- Multi-user concurrent voice sessions.
- Speaking Tanglish (blocked by Woof's language coverage).
- Voice picker — Juno only.
