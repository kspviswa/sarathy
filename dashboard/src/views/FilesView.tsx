import { FileText, Folder, FolderOpen, Loader2, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import type { FileNode } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FilesView() {
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [root, setRoot] = useState("");
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
      setRoot(res.root);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load workspace");
    } finally {
      setLoadingTree(false);
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

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

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FolderOpen className="size-4" />
          <span className="truncate font-mono">{root || "workspace"}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void loadTree()} title="Refresh">
          <RefreshCw className={cn(loadingTree && "animate-spin")} />
        </Button>
      </div>

      <div className="grid flex-1 gap-3 lg:grid-cols-[minmax(0,300px)_1fr]">
        <Card className="min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-2">
              {loadingTree ? (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading…
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {tree?.map((node) => (
                    <TreeNode
                      key={node.path}
                      node={node}
                      expanded={expanded}
                      onToggleDir={toggleDir}
                      onOpen={openFile}
                      selected={path}
                    />
                  ))}
                </ul>
              )}
            </div>
          </ScrollArea>
        </Card>

        <Card className="flex min-h-0 flex-col">
          {path ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
                <span className="truncate font-mono text-sm">{path}</span>
                <div className="flex shrink-0 items-center gap-1">
                  {dirty ? <span className="text-xs text-muted-foreground">unsaved</span> : null}
                  <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
                    <Save />
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
              <textarea
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(true);
                }}
                spellCheck={false}
                className="no-scrollbar flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed focus:outline-none"
              />
            </>
          ) : loadingFile ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              Select a file to view or edit it
            </div>
          )}
        </Card>
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
  depth = 0,
}: {
  node: FileNode;
  expanded: Set<string>;
  onToggleDir: (p: string) => void;
  onOpen: (p: string) => void;
  selected: string | null;
  depth?: number;
}) {
  const isDir = node.type === "dir";
  const isOpen = expanded.has(node.path);
  return (
    <li>
      <button
        onClick={() => (isDir ? onToggleDir(node.path) : onOpen(node.path))}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          !isDir && selected === node.path
            ? "bg-primary text-primary-foreground"
            : "hover:bg-accent hover:text-accent-foreground",
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {isDir ? (
          isOpen ? (
            <FolderOpen className="size-4 shrink-0 text-primary" />
          ) : (
            <Folder className="size-4 shrink-0 text-primary" />
          )
        ) : (
          <FileText className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && isOpen && node.children ? (
        <ul className="space-y-0.5">
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