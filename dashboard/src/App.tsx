import { FileCode2, Gauge, MessageSquareText, Settings } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { api, AuthError, clearToken, getToken } from "@/lib/api";
import { ThemeProvider } from "@/lib/theme";
import { DashboardSocket } from "@/lib/ws";
import { ChatView, type ChatMessage } from "@/views/ChatView";
import { ConfigView } from "@/views/ConfigView";
import { FilesView } from "@/views/FilesView";
import { PairView } from "@/views/PairView";
import { SessionsView } from "@/views/SessionsView";
import { StatusView } from "@/views/StatusView";
import { cn } from "@/lib/utils";

type Tab = "chat" | "files" | "sessions" | "config" | "status";

const TABS: { id: Tab; label: string; icon: typeof MessageSquareText }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "files", label: "Files", icon: FileCode2 },
  { id: "sessions", label: "Sessions", icon: Gauge },
  { id: "config", label: "Config", icon: Settings },
  { id: "status", label: "Status", icon: Gauge },
];

function AppInner() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const socketRef = useRef<DashboardSocket | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setAuthed(false);
      return;
    }
    api
      .me()
      .then(() => setAuthed(true))
      .catch((err) => {
        if (err instanceof AuthError) {
          clearToken();
          setAuthed(false);
        } else {
          toast.error(err instanceof Error ? err.message : "Connection failed");
          setAuthed(true);
        }
      });
  }, []);

  useEffect(() => {
    if (!authed) return;
    const socket = new DashboardSocket();
    socketRef.current = socket;
    const unsubscribe = socket.onMessage((m) => {
      if (m.channel !== "dashboard" && m.chatId !== "console") return;
      if (m.metadata?._progress) {
        setStreaming(true);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") return prev;
          return [...prev, { role: "assistant", content: "", progress: true }];
        });
        return;
      }
      setStreaming(false);
      if (m.metadata?._final) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.progress) {
            return [...prev.slice(0, -1), { role: "assistant", content: m.content }];
          }
          if (last?.role === "assistant" && !last.progress) {
            return [...prev.slice(0, -1), { role: "assistant", content: last.content + m.content }];
          }
          return [...prev, { role: "assistant", content: m.content }];
        });
        return;
      }
      if (m.metadata?._tool_hint) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, toolHint: String(m.metadata._tool_hint) }];
          }
          return [...prev, { role: "assistant", content: "", toolHint: String(m.metadata._tool_hint) }];
        });
        return;
      }
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && !last.progress) {
          return [...prev.slice(0, -1), { ...last, content: last.content + m.content }];
        }
        return [...prev, { role: "assistant", content: m.content }];
      });
    });
    socket.connect();
    return () => {
      unsubscribe();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [authed]);

  const handleSend = useCallback(async (content: string) => {
    setMessages((prev) => [...prev, { role: "user", content }]);
    await api.sendChat(content);
  }, []);

  const handleStop = useCallback(async () => {
    await api.stopChat();
    setStreaming(false);
  }, []);

  if (authed === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="animate-pulse text-sm text-muted-foreground">Connecting…</div>
      </div>
    );
  }

  if (!authed) {
    return <PairView onPaired={() => setAuthed(true)} />;
  }

  const logout = () => {
    void api.logout();
    clearToken();
    setAuthed(false);
  };

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <nav className="safe-bottom order-2 flex shrink-0 items-center justify-around border-t bg-background px-2 py-1 md:order-1 md:w-52 md:flex-col md:items-stretch md:justify-start md:border-r md:border-t-0 md:py-4">
        <div className="mb-4 hidden items-center gap-2 px-3 md:flex">
          <Logo size={28} />
          <span className="font-bold tracking-tight">Sarathy</span>
        </div>
        {TABS.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            variant={tab === id ? "secondary" : "ghost"}
            onClick={() => setTab(id)}
            className={cn(
              "h-11 flex-col gap-1 rounded-lg md:h-10 md:flex-row md:justify-start md:gap-2",
              tab === id && "font-medium",
            )}
          >
            <Icon className="size-5 md:size-4" />
            <span className="text-[11px] md:text-sm">{label}</span>
          </Button>
        ))}
      </nav>

      <main className="order-1 min-h-0 flex-1 md:order-2">
        {tab === "chat" && <ChatView messages={messages} streaming={streaming} onSend={handleSend} onStop={handleStop} />}
        {tab === "files" && <FilesView />}
        {tab === "sessions" && <SessionsView />}
        {tab === "config" && <ConfigView />}
        {tab === "status" && <StatusView onLoggedOut={logout} />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}