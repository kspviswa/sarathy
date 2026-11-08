import { Mic, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PREP_STEP_LABELS, PREP_STEPS } from "@/lib/voice/constants";
import {
  VoiceEngine,
  type PrepStepStatus,
  type VoiceUiPhase,
} from "@/lib/voice/voiceEngine";
import { isVoiceNavLocked, type VoiceNavPhase } from "@/lib/voice/tabLock";
import { cn } from "@/lib/utils";

export type VoiceSessionVariant = "desktop" | "mobile";

export interface VoiceSessionProps {
  variant: VoiceSessionVariant;
  onNavPhaseChange?: (phase: VoiceNavPhase) => void;
}

type StepMap = Record<string, { status: PrepStepStatus; ms?: number }>;

function initialPrep(): StepMap {
  return Object.fromEntries(PREP_STEPS.map((s) => [s, { status: "pending" as const }]));
}

export function VoiceSession({ variant, onNavPhaseChange }: VoiceSessionProps) {
  const engineRef = useRef<VoiceEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<VoiceUiPhase>("idle");
  const [prep, setPrep] = useState<StepMap>(initialPrep);
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [sessionState, setSessionState] = useState("idle");
  const [toolHint, setToolHint] = useState("");
  const [spokenSeq, setSpokenSeq] = useState(0);
  const [busy, setBusy] = useState(false);

  const isMobile = variant === "mobile";

  useEffect(() => {
    onNavPhaseChange?.(phase);
  }, [phase, onNavPhaseChange]);

  useEffect(() => {
    const engine = new VoiceEngine();
    engineRef.current = engine;
    engine.setCallbacks({
      onPhase: setPhase,
      onPrep: (step, status, ms) => {
        setPrep((prev) => ({ ...prev, [step]: { status, ms } }));
      },
      onTranscript: setTranscript,
      onAnswer: (delta) => setAnswer((a) => a + delta),
      onSessionState: (state) => {
        setSessionState(state);
        if (state === "listening") setToolHint("");
      },
      onTool: (name, hint) => {
        setSessionState("thinking");
        setToolHint(hint ? `${name}: ${hint}` : name);
      },
      onSpeakingLine: (seq) => {
        setSpokenSeq(seq);
        setSessionState("speaking");
        setToolHint("");
      },
      onTurnDone: () => {
        setSessionState("listening");
        setToolHint("");
      },
      onError: (msg) => toast.error(msg),
    });
    return () => {
      void engine.teardown();
      engineRef.current = null;
    };
  }, []);

  const activate = useCallback(async () => {
    if (busy || !engineRef.current) return;
    setBusy(true);
    setPrep(initialPrep());
    setTranscript("");
    setAnswer("");
    try {
      await engineRef.current.activate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start voice session");
      void engineRef.current?.teardown();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const cancel = useCallback(async () => {
    await engineRef.current?.cancel();
    setPrep(initialPrep());
    setTranscript("");
    setAnswer("");
  }, []);

  const endSession = useCallback(async () => {
    await engineRef.current?.endSession();
    setTranscript("");
    setAnswer("");
  }, []);

  useEffect(() => {
    if (phase !== "live") return;
    let raf = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = (level: number) => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const bars = 24;
      const gap = 2;
      const barW = (w - gap * (bars - 1)) / bars;
      for (let i = 0; i < bars; i += 1) {
        const jitter = 0.35 + Math.random() * 0.65;
        const bh = Math.max(4, level * h * jitter);
        const x = i * (barW + gap);
        ctx.fillStyle = "hsl(var(--primary))";
        ctx.fillRect(x, (h - bh) / 2, barW, bh);
      }
      raf = requestAnimationFrame(() => draw(level * 0.92 + 0.04));
    };
    raf = requestAnimationFrame(() => draw(0.12));
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  const activityLabel = useMemo(() => {
    if (toolHint) return toolHint;
    if (sessionState === "thinking") return "Thinking…";
    if (sessionState === "speaking") {
      return spokenSeq > 0 ? `Speaking… (sentence ${spokenSeq})` : "Speaking…";
    }
    if (sessionState === "listening") return "Listening…";
    return "";
  }, [sessionState, toolHint, spokenSeq]);

  const activateControl = (
    <Button
      size="lg"
      className="min-w-40"
      data-testid="voice-activate"
      disabled={busy}
      onClick={() => void activate()}
    >
      <Mic className="size-4" />
      Activate
    </Button>
  );

  const cancelControl = (
    <Button variant="secondary" data-testid="voice-cancel" onClick={() => void cancel()}>
      Cancel
    </Button>
  );

  const endControl = (
    <Button
      variant="destructive"
      size="lg"
      className={cn(
        "min-w-48 animate-pulse shadow-lg shadow-destructive/30 motion-reduce:animate-none",
        isMobile && "w-full max-w-sm",
      )}
      data-testid="voice-end-session"
      onClick={() => void endSession()}
    >
      <Square className="size-4" />
      End Session
    </Button>
  );

  const prepList = (
    <ul className="w-full max-w-md space-y-2" data-testid="voice-prep-steps">
      {PREP_STEPS.map((step) => {
        const row = prep[step] ?? { status: "pending" as const };
        const label = PREP_STEP_LABELS[step] ?? step;
        return (
          <li
            key={step}
            className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-sm"
            data-testid={`voice-prep-${step}`}
            data-status={row.status}
          >
            <span>{label}</span>
            <span className="text-muted-foreground">
              {row.status}
              {typeof row.ms === "number" ? ` · ${row.ms}ms` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );

  const shellClass = cn(
    "flex min-h-0 flex-1 flex-col",
    isMobile ? "px-3 py-4" : "px-6 py-8",
  );

  const centreClass = cn(
    "flex flex-1 flex-col items-center justify-center gap-6 text-center",
    isVoiceNavLocked(phase) && "select-none",
  );

  return (
    <div className={shellClass} data-testid="voice-session">
      {phase === "idle" && (
        <div className={centreClass}>
          <div
            className="flex size-28 items-center justify-center rounded-full bg-primary/10 text-primary"
            aria-hidden
          >
            <Mic className="size-12" />
          </div>
          <div>
            <h1 className={cn("font-semibold tracking-tight", isMobile ? "text-xl" : "text-2xl")}>
              Voice
            </h1>
            <p className="mt-1 max-w-sm text-base text-muted-foreground">
              Speak freely — Sarathy answers aloud as the reply streams.
            </p>
          </div>
          {activateControl}
        </div>
      )}

      {phase === "preparing" && (
        <div className={cn(centreClass, "gap-4")}>
          <p className="text-base text-muted-foreground">Preparing voice session…</p>
          {prepList}
          {cancelControl}
        </div>
      )}

      {(phase === "live" || phase === "ending") && (
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-4",
            isMobile ? "pb-safe" : "max-w-3xl mx-auto w-full",
          )}
        >
          <canvas
            ref={canvasRef}
            width={isMobile ? 320 : 480}
            height={72}
            className="w-full rounded-lg border border-border/60 bg-muted/30"
            data-testid="voice-waveform"
            aria-hidden
          />
          {activityLabel ? (
            <p className="text-sm text-muted-foreground" data-testid="voice-activity">
              {activityLabel}
            </p>
          ) : null}
          <div
            className="min-h-24 flex-1 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 p-3 text-base"
            data-testid="voice-transcript"
          >
            {transcript || <span className="text-muted-foreground">Transcript appears here…</span>}
            {answer ? (
              <p className="mt-3 border-t border-border/50 pt-3 text-foreground/90">{answer}</p>
            ) : null}
          </div>
          <div className={cn("flex justify-center pt-2", isMobile && "pb-2")}>{endControl}</div>
          {phase === "ending" ? (
            <p className="text-center text-sm text-muted-foreground">Closing session…</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
