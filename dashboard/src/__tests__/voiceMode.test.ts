import { describe, expect, it } from "vitest";

import {
  assembleVoiceTranscript,
  commitPartial,
} from "@/lib/voice/transcriptAssembly";
import { buildVoiceWsUrl, shrutiModelUrl, voiceApiBase } from "@/lib/voice/urls";
import { attemptVoiceAwareNav, isVoiceNavLocked } from "@/lib/voice/tabLock";
import { VOICE_STT_MODE } from "@/lib/voice/constants";

describe("voice URLs", () => {
  it("buildVoiceWsUrl encodes token against host", () => {
    const url = buildVoiceWsUrl({
      protocol: "ws:",
      host: "localhost:8787",
      token: "a+b/c",
    });
    expect(url).toBe("ws://localhost:8787/ws/voice?token=a%2Bb%2Fc");
  });

  it("shrutiModelUrl uses voiceApiBase", () => {
    expect(voiceApiBase("https://sarathy.local/")).toBe("https://sarathy.local");
    expect(shrutiModelUrl("https://sarathy.local")).toBe(
      "https://sarathy.local/api/voice/model/shruti-tamil.cact",
    );
  });
});

describe("voice transcript assembly", () => {
  it("commits final partials and keeps the open phrase", () => {
    let committed: string[] = [];
    let current = "";
    ({ committed, current } = commitPartial(committed, { text: "hello", is_final: false }));
    expect(current).toBe("hello");
    expect(committed).toEqual([]);

    ({ committed, current } = commitPartial(committed, { text: "hello world", is_final: true }));
    expect(committed).toEqual(["hello world"]);
    expect(current).toBe("");
  });

  it("assembleVoiceTranscript joins committed, partial, and trailing", () => {
    const text = assembleVoiceTranscript(["first phrase"], "partial", "tail");
    expect(text).toBe("first phrase partial tail");
  });
});

describe("voice tab lock", () => {
  it("locks during preparing and live", () => {
    expect(isVoiceNavLocked("preparing")).toBe(true);
    expect(isVoiceNavLocked("live")).toBe(true);
    expect(isVoiceNavLocked("idle")).toBe(false);
  });

  it("attemptVoiceAwareNav blocks non-voice targets while locked", () => {
    expect(attemptVoiceAwareNav("live", "chat")).toBe(false);
    expect(attemptVoiceAwareNav("live", "voice")).toBe(true);
    expect(attemptVoiceAwareNav("idle", "chat")).toBe(true);
  });
});

describe("voice STT mode export", () => {
  it("ships the spike-selected STT path", () => {
    expect(VOICE_STT_MODE).toBe("server_stt");
  });
});
