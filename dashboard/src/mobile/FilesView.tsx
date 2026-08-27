import { ChevronRight, FileText, Folder, FolderOpen, Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { FileNode } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FilesView({ initialFile }: { initialFile?: string | null }) {
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loadingTree, setLoadingTree] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadTree = useCallback(async () => {
    setLoadingTree(true);
    try {
      const res = await api.workspaceTree();
      setTree(res.tree);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load workspace");
    } finally {
      setLoadingTree(false);
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (initialFile && !loadingTree) {
      void openFile(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile, loadingTree]);

  async function openFile(p: string) {
    setLoadingFile(true);
    try {
      const res = await api.readFile(p);
      setPath(res.path);
      setContent(res.content);
      setDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to read file");
    } finally {
      setLoadingFile(false);
    }
  }

  async function save() {
    if (!path) return;
    setSaving(true);
    try {
      await api.writeFile(path, content);
      setDirty(false);
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function toggleDir(p: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  if (path) {
    return (
      <div className="flex h-full flex-col" data-testid="mobile-files">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <button className="text-primary" onClick={() => setPath(null)}>
            ← Files
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {path}
          </span>
          <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
            <Save className="size-4" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
        {loadingFile ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            className="no-scrollbar flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed focus:outline-none"
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="mobile-files">
      <div className="border-b px-4 py-3">
        <h1 className="text-base font-semibold">Files</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loadingTree ? (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <ul className="flex flex-col">
            {tree?.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                expanded={expanded}
                onToggleDir={toggleDir}
                onOpen={openFile}
                selected={path}
                depth={0}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  expanded,
  onToggleDir,
  onOpen,
  selected,
  depth,
}: {
  node: FileNode;
  expanded: Set<string>;
  onToggleDir: (p: string) => void;
  onOpen: (p: string) => void;
  selected: string | null;
  depth: number;
}) {
  const isDir = node.type === "dir";
  const isOpen = expanded.has(node.path);
  return (
    <li>
      <button
        onClick={() => (isDir ? onToggleDir(node.path) : onOpen(node.path))}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-base transition-colors",
          !isDir && selected === node.path ? "bg-primary text-primary-foreground" : "hover:bg-accent",
        )}
        style={{ paddingLeft: `${(depth + 1) * 14}px` }}
      >
        {isDir ? (
          isOpen ? (
            <FolderOpen className="size-5 shrink-0 text-primary" />
          ) : (
            <Folder className="size-5 shrink-0 text-primary" />
          )
        ) : (
          <FileText className="size-5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
        {isDir ? <ChevronRight className="ml-auto size-4 text-muted-foreground" /> : null}
      </button>
      {isDir && isOpen && node.children ? (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              expanded={expanded}
              onToggleDir={onToggleDir}
              onOpen={onOpen}
              selected={selected}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
