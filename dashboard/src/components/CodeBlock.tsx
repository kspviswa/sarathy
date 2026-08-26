import { Check, ChevronDown, ChevronRight, Copy, FileCode2 } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MAX_COLLAPSE_LINES = 400;

interface CodeBlockProps {
  children: React.ReactNode;
  className?: string;
  onOpenFile?: (path: string) => void;
}

function parseFenceInfo(info: string): { language: string; filename: string | null } {
  const trimmed = info.trim();
  if (!trimmed) return { language: "", filename: null };

  const parts = trimmed.split(/\s+/);
  let language = "";
  let filename: string | null = null;

  for (const part of parts) {
    if (!language && /^[a-zA-Z0-9_-]+$/.test(part)) {
      language = part;
    } else if (part.includes("/") || part.includes(".") || part.includes(":")) {
      filename = part.includes(":") ? part.split(":").slice(1).join(":") : part;
    }
  }

  if (language && !filename) {
    const extMap: Record<string, string> = {
      js: "script.js",
      jsx: "component.jsx",
      ts: "file.ts",
      tsx: "component.tsx",
      py: "script.py",
      rb: "script.rb",
      go: "main.go",
      rs: "main.rs",
      java: "Main.java",
      cpp: "main.cpp",
      c: "main.c",
      sh: "script.sh",
      bash: "script.sh",
      zsh: "script.zsh",
      sql: "query.sql",
      html: "index.html",
      css: "styles.css",
      json: "data.json",
      yaml: "config.yaml",
      yml: "config.yml",
      toml: "config.toml",
      md: "document.md",
      dockerfile: "Dockerfile",
    };
    const lower = language.toLowerCase();
    if (lower === "dockerfile") {
      filename = "Dockerfile";
    } else if (extMap[lower]) {
      filename = extMap[lower];
    }
  }

  return { language: language.toLowerCase(), filename };
}

export function CodeBlock({ children, className, onOpenFile }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const code = String(children).replace(/\n$/, "");
  const lineCount = code.split("\n").length;
  const isCollapsible = lineCount > MAX_COLLAPSE_LINES;

  const infoMatch = className?.match(/language-([^\s]+)/);
  const rawInfo = infoMatch ? infoMatch[1] : className?.replace("language-", "") || "";
  const { language, filename } = parseFenceInfo(rawInfo);

  const copyToClipboard = useCallback(() => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {language && (
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary uppercase">
              {language}
            </span>
          )}
          {filename && (
            <span className="flex items-center gap-1 truncate font-mono text-xs text-muted-foreground">
              <FileCode2 className="size-3 shrink-0" />
              {filename}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {filename && onOpenFile && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onOpenFile(filename!)}
            >
              <FileCode2 className="size-3" />
              Open in Files
            </Button>
          )}
          {isCollapsible && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              {expanded ? "Collapse" : `Show all ${lineCount} lines`}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={copyToClipboard}
          >
            {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      <div
        className={cn(
          "overflow-x-auto",
          isCollapsible && !expanded && "max-h-64",
        )}
      >
        <pre className="p-3 text-[13px] leading-relaxed">
          <code className={cn("font-mono", className)}>
            {isCollapsible && !expanded
              ? code.split("\n").slice(0, MAX_COLLAPSE_LINES).join("\n") + "\n..."
              : code}
          </code>
        </pre>
      </div>
    </div>
  );
}
