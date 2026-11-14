/**
 * Throwaway browser harness for spec 175 screenshots.
 * Served by `vite --port 5179 verify175.html` — not shipped.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

import { DEFAULT_SUGGESTIONS, GreetingState } from "@/components/GreetingState";
import { QuoteActionBar } from "@/components/QuoteAsk";
import {
  ComposerFormatToolbar,
  ComposerMarkdownPreview,
} from "@/components/ComposerFormatToolbar";
import { MessageActions } from "@/components/MessageActions";
import { MediaAttachments } from "@/components/ChatMedia";
import { ChatFontScaleControl } from "@/components/ChatFontScaleControl";
import { MarkdownBubble } from "@/components/MarkdownBubble";
import { AskTurnCard } from "@/components/ask/AskTurnCard";
import { AskResearchProgress } from "@/components/ask/AskResearchProgress";
import { LightboxProvider } from "@/lib/lightbox";
import type { AskMedia, AskStep, AskTurn } from "@/lib/ask";

const DENSE =
  "The **Mahābhārata** is an epic of India. Krishna advises Arjuna on the " +
  "battlefield of Kurukṣetra. Dharma, karma, and mokṣa weave through every " +
  "parva. Select any phrase in this paragraph to raise the follow-up bar.";

function makeTurn(media: AskMedia[] = []): AskTurn {
  return {
    id: "t1",
    query: "What is the capital of France?",
    mode: "speed",
    sources: [],
    answer: "Paris is the capital of France.",
    sourcesList: [],
    steps: [],
    createdAt: 0,
    media,
  };
}

const SAMPLE_MEDIA: AskMedia[] = [
  {
    kind: "image",
    url: "https://images.test/a.jpg",
    img_src:
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect fill="#c45c26" width="200" height="200"/><text x="50%" y="50%" fill="white" text-anchor="middle" dy=".3em">A</text></svg>`,
      ),
    title: "A",
  },
  {
    kind: "image",
    url: "https://images.test/b.jpg",
    img_src:
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect fill="#2d6a4f" width="200" height="200"/><text x="50%" y="50%" fill="white" text-anchor="middle" dy=".3em">B</text></svg>`,
      ),
    title: "B",
  },
];

const STEPS_500: AskStep[] = Array.from({ length: 500 }, (_, i) => ({
  kind: "reasoning" as const,
  reasoning: `Research step ${i + 1}: examining source material and cross-checking claims.`,
}));

function Scene({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      data-testid={`scene-${id}`}
      className="min-h-screen border-b border-border p-6"
    >
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ChatScaleDemo({ large }: { large?: boolean }) {
  // Local scale for the screenshot scene — avoid fighting the shared storage key
  // when both min and max scenes mount on one page.
  const [scale, setScale] = useState(large ? 1.4 : 0.9);
  const style = { ["--chat-font-scale" as string]: String(scale) } as CSSProperties;
  return (
    <div data-chat-scale="" style={style} className="space-y-3">
      <ChatFontScaleControl
        scale={scale as 0.9 | 1.0 | 1.125 | 1.25 | 1.4}
        onIncrease={() => setScale((s) => Math.min(1.4, s + 0.125))}
        onDecrease={() => setScale((s) => Math.max(0.9, s - 0.1))}
        onReset={() => setScale(1)}
      />
      <div
        data-chat-body=""
        className="max-w-md rounded-2xl border border-border bg-card px-4 py-2.5"
      >
        <MarkdownBubble content="The quick brown fox jumps over the lazy dog. **Bold** and *italic* scale with the control." />
      </div>
      <textarea
        data-chat-composer=""
        className="w-full rounded-lg border border-border px-3 py-2"
        defaultValue="Composer text at this scale."
      />
    </div>
  );
}

function QuoteBarOverCard() {
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const scene = document.querySelector('[data-testid="scene-quote-bar"]');
    if (!scene) return;
    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.4 },
    );
    io.observe(scene);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!inView) {
      setRect(null);
      return;
    }
    const card = document.querySelector('[data-testid="quote-bar-card"]');
    if (!card) return;
    const place = () => {
      const r = card.getBoundingClientRect();
      setRect({ top: r.top + 16, left: r.left + 16 });
    };
    place();
    window.addEventListener("scroll", place, true);
    return () => window.removeEventListener("scroll", place, true);
  }, [inView]);
  return <QuoteActionBar visible={inView && !!rect} rect={rect} onAdd={() => {}} />;
}

function ComposerDemo() {
  const [value, setValue] = useState("Type **bold**, *italic*, and `code` here.");
  const [preview, setPreview] = useState(true);
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="max-w-xl space-y-2 rounded-xl border border-border bg-card p-3">
      <ComposerFormatToolbar
        value={value}
        onChange={setValue}
        textareaRef={ref}
        preview={preview}
        onPreviewChange={setPreview}
      />
      {preview ? (
        <ComposerMarkdownPreview content={value} />
      ) : (
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-h-20 w-full rounded-lg border border-border px-3 py-2"
        />
      )}
    </div>
  );
}

function App() {
  return (
    <LightboxProvider>
      <main className="mx-auto max-w-5xl">
        <Scene id="greeting" title="01 greeting">
          <GreetingState suggestions={DEFAULT_SUGGESTIONS} onPick={() => {}} />
        </Scene>

        <Scene id="quote-bar" title="02 quote bar">
          <div
            className="relative max-w-2xl rounded-2xl border border-border bg-card px-4 py-3"
            data-testid="quote-bar-card"
          >
            <MarkdownBubble content={DENSE} />
          </div>
          {/* Positioned after layout so the fixed bar sits over the dense card. */}
          <QuoteBarOverCard />
        </Scene>

        <Scene id="composer" title="03 composer preview">
          <ComposerDemo />
        </Scene>

        <Scene id="user-actions" title="04 user actions">
          <div className="flex justify-end">
            <div
              className="group max-w-[85%] rounded-2xl bg-primary px-4 py-2 text-primary-foreground"
              data-chat-body=""
            >
              <MarkdownBubble content="Can you explain the **lākāras**?" onPrimary />
              <div className="mt-0.5 flex justify-end [&_[data-testid=message-actions]]:opacity-100">
                <MessageActions
                  content="Can you explain the lākāras?"
                  onReply={() => {}}
                  onPrimary
                />
              </div>
            </div>
          </div>
        </Scene>

        <Scene id="thumbnail" title="05 thumbnail">
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2 text-primary-foreground">
              <MediaAttachments
                paths={["/tmp/photo.png"]}
                onPrimary
              />
              {/* Override the broken /api/media img with a data URI for the shot */}
              <style>{`
                [data-testid="scene-thumbnail"] img {
                  content: url("data:image/svg+xml,${encodeURIComponent(
                    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop stop-color='#e76f51'/><stop offset='1' stop-color='#f4a261'/></linearGradient></defs><rect width='160' height='160' fill='url(#g)'/><circle cx='80' cy='70' r='28' fill='#fff6'/><text x='50%' y='88%' fill='white' font-size='14' text-anchor='middle'>photo</text></svg>`,
                  )}");
                }
              `}</style>
              <MarkdownBubble content="Here is the photo." onPrimary />
            </div>
          </div>
        </Scene>

        <Scene id="font-small" title="06 font small">
          <ChatScaleDemo />
        </Scene>

        <Scene id="font-large" title="07 font large">
          <ChatScaleDemo large />
        </Scene>

        <Scene id="ask-before" title="08 ask before media">
          <div className="rounded-xl border border-border p-4" data-testid="ask-before-wrap">
            <AskTurnCard
              turn={makeTurn([])}
              streaming={false}
              onReply={() => {}}
              onQuote={() => {}}
              onRewrite={() => {}}
              onSummarize={() => {}}
              alwaysShowActions
            />
          </div>
        </Scene>

        <Scene id="ask-after" title="09 ask after media">
          <div className="rounded-xl border border-border p-4" data-testid="ask-after-wrap">
            <AskTurnCard
              turn={makeTurn(SAMPLE_MEDIA)}
              streaming={false}
              onReply={() => {}}
              onQuote={() => {}}
              onRewrite={() => {}}
              onSummarize={() => {}}
              alwaysShowActions
            />
          </div>
        </Scene>

        <Scene id="progress" title="10 progress expanded">
          <AskResearchProgress steps={STEPS_500} streaming={false} />
        </Scene>

        <Scene id="mobile-greeting" title="11 mobile greeting">
          <div className="mx-auto w-[390px] rounded-xl border border-border bg-background p-4">
            <GreetingState suggestions={DEFAULT_SUGGESTIONS} onPick={() => {}} />
          </div>
        </Scene>

        <Scene id="mobile-composer" title="12 mobile composer">
          <div className="mx-auto w-[390px] rounded-xl border border-border bg-background p-3">
            <ComposerDemo />
          </div>
        </Scene>

        <Scene id="mobile-user-bubble" title="13 mobile user bubble">
          <div className="mx-auto w-[390px] rounded-xl border border-border bg-background p-4">
            <div className="flex justify-end">
              <div className="group max-w-[88%] rounded-2xl bg-primary px-4 py-2.5 text-primary-foreground">
                <MediaAttachments paths={["/tmp/shot.jpg"]} onPrimary />
                <style>{`
                  [data-testid="scene-mobile-user-bubble"] img {
                    content: url("data:image/svg+xml,${encodeURIComponent(
                      `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><rect fill='#264653' width='160' height='160'/><text x='50%' y='50%' fill='white' text-anchor='middle' dy='.3em'>img</text></svg>`,
                    )}");
                  }
                `}</style>
                <MarkdownBubble content="Mobile bubble with reply/copy." onPrimary />
                <div className="mt-2 flex justify-end [&_[data-testid=message-actions]]:opacity-100">
                  <MessageActions
                    content="Mobile bubble"
                    onReply={() => {}}
                    onPrimary
                  />
                </div>
              </div>
            </div>
          </div>
        </Scene>
      </main>
    </LightboxProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
