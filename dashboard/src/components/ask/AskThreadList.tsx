import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  FolderOpen,
  MessageSquarePlus,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useCoarsePointer } from "@/lib/useCoarsePointer";
import { Button } from "@/components/ui/button";
import {
  createAskGroup,
  createAskThreadInGroup,
  deleteAskGroup,
  deleteAskThread,
  ensureAskGroupsLoaded,
  ensureAskThreadsLoaded,
  getAskGroups,
  getAskThreads,
  getActiveAskThreadId,
  getCollapsedAskGroups,
  loadAskGroups,
  loadAskThreads,
  moveAskThread,
  renameAskGroup,
  setActiveAskThreadId,
  subscribeAskGroupCollapse,
  subscribeAskGroups,
  subscribeAskThreadList,
  toggleAskGroupCollapsed,
  type AskGroup,
  type AskThread,
} from "@/lib/ask";
import { relativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/**
 * The Ask threads — the "Asks" list of the Sessions surface (spec §C).
 *
 * The Ask canvas has no history rail of its own: a research thread is a
 * conversation, and conversations live with the other conversations. This
 * lists them: the first question, how many turns it took, when it was last
 * touched, and a way to forget one.
 *
 * The list comes from the SERVER (job 150 §B) — the threads used to live in
 * the browser's `localStorage`, which meant they were lost with the data and
 * invisible from any other device.
 *
 * And it is GROUPED (job 151 §B): the threads are sorted into named groups
 * (Uttaram calls them projects), one collapsible section per group, and the
 * threads that belong to no group under Uncategorized at the end. The groups
 * come from the server too — the browser keeps no private copy of them.
 *
 * ONE component, so the desktop Sessions tab and the mobile Sessions drawer
 * offer exactly the same history (HARD LESSON 22).
 */
export function AskThreadList({
  onOpenThread,
}: {
  /** Open the thread in the Ask canvas. */
  onOpenThread: (threadId: string) => void;
}) {
  const [threads, setThreads] = useState<AskThread[]>(() => getAskThreads());
  const [groups, setGroups] = useState<AskGroup[]>(() => getAskGroups());
  const [collapsed, setCollapsed] = useState<string[]>(() => getCollapsedAskGroups());
  const coarse = useCoarsePointer();

  // The stores are the one copy of the data: this list reads them instead
  // of keeping a private copy.
  useEffect(() => subscribeAskThreadList(() => setThreads(getAskThreads())), []);
  useEffect(() => subscribeAskGroups(() => setGroups(getAskGroups())), []);
  useEffect(
    () => subscribeAskGroupCollapse(() => setCollapsed(getCollapsedAskGroups())),
    [],
  );

  // The first load: the browser's old history is carried over to the
  // server, and the threads and the groups are read from there.
  useEffect(() => {
    void ensureAskThreadsLoaded();
    void ensureAskGroupsLoaded();
  }, []);

  /**
   * Read the threads and the groups again.
   *
   * Every change to a group is followed by a refresh: the count of a group
   * and the group of a thread are the SERVER's facts, and the list shows
   * what the server holds.
   */
  const refresh = useCallback(async () => {
    await Promise.all([
      loadAskThreads().catch(() => undefined),
      loadAskGroups().catch(() => undefined),
    ]);
  }, []);

  // Deleting a thread destroys its turns, so BOTH entry points (the
  // always-visible button and the touch swipe action) go through ONE
  // confirmation dialog. It lives here, not inside every row: one instance,
  // driven by the pending thread id.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Which row is swiped open on a touch device. One at a time, by
  // construction — opening a row is setting this to its id.
  const [openSwipeId, setOpenSwipeId] = useState<string | null>(null);

  const closeDeleteDialog = useCallback(() => {
    setPendingDeleteId(null);
  }, []);

  /** Ask before deleting: the dialog is the only entry to the delete path. */
  const requestDelete = useCallback((id: string) => {
    setPendingDeleteId(id);
  }, []);

  const handleDeleteConfirm = useCallback(
    async (id: string) => {
      try {
        // Clear the canvas when the thread being deleted is the open one.
        if (getActiveAskThreadId() === id) setActiveAskThreadId(null);
        await deleteAskThread(id);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not delete the thread",
        );
      }
      closeDeleteDialog();
      setOpenSwipeId(null);
    },
    [closeDeleteDialog],
  );

  const pendingThread = pendingDeleteId
    ? threads.find((thread) => thread.id === pendingDeleteId)
    : undefined;

  /** Start a new ask inside a group: the thread is born there. */
  const startInGroup = useCallback(
    async (group: AskGroup) => {
      try {
        const thread = await createAskThreadInGroup(group.id);
        await refresh();
        onOpenThread(thread.id);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not start a new ask in the group",
        );
      }
    },
    [onOpenThread, refresh],
  );

  /** Move a thread into a group — or out of every group. */
  const move = useCallback(
    async (thread: AskThread, groupId: string | null) => {
      try {
        await moveAskThread(thread.id, groupId);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not move the thread");
      }
    },
    [refresh],
  );

  const uncategorized = threads.filter((thread) => !thread.groupId);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ask-thread-list">
      <div className="shrink-0 border-b p-2">
        <NewGroupControl onCreated={refresh} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.map((group) => (
          <GroupSection
            key={group.id}
            group={group}
            threads={threads.filter((thread) => thread.groupId === group.id)}
            groups={groups}
            collapsed={collapsed.includes(group.id)}
            onToggle={() => toggleAskGroupCollapsed(group.id)}
            onNewAsk={() => void startInGroup(group)}
            onRefresh={refresh}
            onOpen={onOpenThread}
            onRequestDelete={requestDelete}
            onMove={move}
            coarse={coarse}
            openSwipeId={openSwipeId}
            onSwipeOpen={setOpenSwipeId}
          />
        ))}

        {uncategorized.length > 0 && (
          <section className="mt-2" data-testid="ask-uncategorized">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground"
                data-testid="ask-uncategorized-name"
              >
                Uncategorized
              </span>
              <span className="text-xs text-muted-foreground" data-testid="ask-uncategorized-count">
                {uncategorized.length}
              </span>
            </div>
            <ul className="space-y-1">
              {uncategorized.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  groups={groups}
                  onOpen={onOpenThread}
                  onRequestDelete={requestDelete}
                  onMove={move}
                  coarse={coarse}
                  openSwipeId={openSwipeId}
                  onSwipeOpen={setOpenSwipeId}
                />
              ))}
            </ul>
          </section>
        )}

        {groups.length === 0 && threads.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground" data-testid="ask-threads-empty">
            No research threads yet — ask something in the Ask tab.
          </p>
        )}

      </div>

      {/* ONE dialog for the whole list — driven by the pending thread id, so
          both the always-visible button and the touch swipe action confirm
          through the same place. It is mounted outside the scroller so the
          overlay is not clipped. */}
      <Dialog
        open={pendingDeleteId !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) closeDeleteDialog();
        }}
      >
        <DialogContent data-testid="ask-thread-delete-dialog">
          <DialogHeader>
            <DialogTitle>Delete this ask?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {pendingThread ? `"${pendingThread.title || "New ask"}"` : "This thread"}{" "}
            and its turns will be deleted. This cannot be undone.
          </DialogDescription>
          <DialogFooter>
            <button
              type="button"
              onClick={closeDeleteDialog}
              data-testid="ask-thread-delete-cancel"
              className="flex items-center gap-2 rounded-sm border px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (pendingDeleteId) void handleDeleteConfirm(pendingDeleteId);
              }}
              data-testid="ask-thread-delete-confirm"
              className="flex items-center gap-2 rounded-sm bg-destructive px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-destructive/90"
            >
              <Trash2 className="size-3.5" />
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The "New group" control — a Plus and a label that become an input.
 *
 * Enter creates the group, Escape cancels it. The group is created on the
 * SERVER; the list is read again afterwards.
 */
function NewGroupControl({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const cancel = useCallback(() => {
    setName("");
    setOpen(false);
  }, []);

  const commit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await createAskGroup(trimmed);
      setName("");
      setOpen(false);
      await onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the group");
    }
  }, [name, onCreated]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="ask-new-group"
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-4" />
        New group
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1" data-testid="ask-new-group-form">
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit();
          if (event.key === "Escape") cancel();
        }}
        placeholder="Group name"
        aria-label="New group name"
        data-testid="ask-new-group-input"
        className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-ring"
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => void commit()}
        aria-label="Create the group"
        title="Create the group"
        data-testid="ask-new-group-commit"
      >
        <Check className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={cancel}
        aria-label="Cancel the new group"
        title="Cancel"
        data-testid="ask-new-group-cancel"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

/**
 * One group — its header, and the threads filed under it.
 *
 * The header carries the chevron that folds the section away, the folder
 * icon, the name and the thread count, the button that starts a new ask
 * inside the group, and the menu that renames or deletes the group.
 */
function GroupSection({
  group,
  threads,
  groups,
  collapsed,
  onToggle,
  onNewAsk,
  onRefresh,
  onOpen,
  onRequestDelete,
  onMove,
  coarse,
  openSwipeId,
  onSwipeOpen,
}: {
  group: AskGroup;
  threads: AskThread[];
  groups: AskGroup[];
  collapsed: boolean;
  onToggle: () => void;
  onNewAsk: () => void;
  onRefresh: () => void | Promise<void>;
  onOpen: (threadId: string) => void;
  onRequestDelete: (id: string) => void;
  onMove: (thread: AskThread, groupId: string | null) => void;
  coarse: boolean;
  openSwipeId: string | null;
  onSwipeOpen: (id: string | null) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.name);

  const commitRename = useCallback(async () => {
    const trimmed = name.trim();
    setRenaming(false);
    if (!trimmed || trimmed === group.name) return;
    try {
      await renameAskGroup(group.id, trimmed);
      await onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rename the group");
    }
  }, [group.id, group.name, name, onRefresh]);

  const remove = useCallback(async () => {
    // The same destructive-confirm pattern the thread delete uses. The
    // threads survive: they fall back to Uncategorized.
    if (
      !window.confirm(
        `Delete the group "${group.name}"? Its threads stay — they move to Uncategorized.`,
      )
    ) {
      return;
    }
    try {
      await deleteAskGroup(group.id);
      await onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the group");
    }
  }, [group.id, group.name, onRefresh]);

  if (renaming) {
    return (
      <div className="mb-1" data-testid="ask-group-rename-form">
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void commitRename();
              if (event.key === "Escape") {
                setName(group.name);
                setRenaming(false);
              }
            }}
            aria-label={`Rename ${group.name}`}
            data-testid="ask-group-name-input"
            className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-sm outline-none focus:border-ring"
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void commitRename()}
            aria-label="Save the group name"
            title="Save the group name"
            data-testid="ask-group-rename-commit"
          >
            <Check className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => {
              setName(group.name);
              setRenaming(false);
            }}
            aria-label="Cancel the rename"
            title="Cancel"
            data-testid="ask-group-rename-cancel"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section className="mb-2" data-testid="ask-group" data-group-id={group.id}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.name}`}
          title={collapsed ? "Expand" : "Collapse"}
          data-testid="ask-group-toggle"
          data-group-id={group.id}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
        >
          {collapsed ? (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          )}
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium" data-testid="ask-group-name">
            {group.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground" data-testid="ask-group-count">
            {group.threadCount}
          </span>
        </button>

        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onNewAsk}
          aria-label={`New ask in ${group.name}`}
          title={`New ask in ${group.name}`}
          data-testid="ask-group-new"
        >
          <MessageSquarePlus className="size-4" />
        </Button>

        <GroupMenu group={group} onRename={() => setRenaming(true)} onDelete={() => void remove()} />
      </div>

      {!collapsed && (
        <ul className="space-y-1 pl-2">
          {threads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              groups={groups}
              onOpen={onOpen}
              onRequestDelete={onRequestDelete}
              onMove={onMove}
              coarse={coarse}
              openSwipeId={openSwipeId}
              onSwipeOpen={onSwipeOpen}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The group's menu — rename it, or delete it. */
function GroupMenu({
  group,
  onRename,
  onDelete,
}: {
  group: AskGroup;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Options for ${group.name}`}
        title="Group options"
        data-testid="ask-group-menu"
      >
        <MoreHorizontal className="size-4" />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full z-20 mt-1 min-w-[9rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            data-testid="ask-group-menu-panel"
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRename();
              }}
              data-testid="ask-group-rename"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Pencil className="size-3.5" />
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              data-testid="ask-group-delete"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive transition-colors hover:bg-accent"
            >
              <Trash2 className="size-3.5" />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One thread — its title, how old it is, and the controls that act on it.
 *
 * Deleting is discoverable on both shells: the trash button is always
 * visible on a fine pointer, and on a coarse pointer (touch) swiping the row
 * left reveals a red Delete. Both paths end in the same confirmation dialog
 * rendered by the list.
 *
 * The move control lists every group plus "Uncategorized", and the group the
 * thread is in is the one that is highlighted.
 */

/** How far a row travels when it snaps open. */
const SWIPE_OPEN_X = -88;
/** Travel past which the row stays open instead of snapping back. */
const SWIPE_THRESHOLD = 40;

function ThreadRow({
  thread,
  groups,
  onOpen,
  onRequestDelete,
  onMove,
  coarse,
  openSwipeId,
  onSwipeOpen,
}: {
  thread: AskThread;
  groups: AskGroup[];
  onOpen: (threadId: string) => void;
  onRequestDelete: (id: string) => void;
  onMove: (thread: AskThread, groupId: string | null) => void;
  coarse: boolean;
  /** The row that is currently swiped open, if any. */
  openSwipeId: string | null;
  onSwipeOpen: (id: string | null) => void;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [swipeX, setSwipeX] = useState(0);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  // The gesture is decided once: a vertical drag hands the row back to the
  // list's scroller and stays inert until the pointer is lifted.
  const draggingRef = useRef(false);
  const verticalRef = useRef(false);

  const open = coarse && openSwipeId === thread.id;
  const offset = open ? SWIPE_OPEN_X : swipeX;

  // Only one row may be open: when another row takes the swipe, this one
  // closes.
  useEffect(() => {
    if (!open) setSwipeX(0);
  }, [open]);

  const resetGesture = () => {
    draggingRef.current = false;
    verticalRef.current = false;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLLIElement>) => {
    if (!coarse) return;
    // A press on an ACTION control (move, delete) is a tap, not a swipe. The
    // row body is itself a button, though — that is where a swipe starts.
    const target = event.target as HTMLElement;
    if (target.closest("button") && !target.closest('[data-testid="ask-thread-item"]')) return;
    draggingRef.current = true;
    verticalRef.current = false;
    startXRef.current = event.clientX;
    startYRef.current = event.clientY;
    setSwipeX(open ? SWIPE_OPEN_X : 0);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLLIElement>) => {
    if (!coarse || !draggingRef.current) return;
    const dx = event.clientX - startXRef.current;
    const dy = event.clientY - startYRef.current;

    // A vertical drag scrolls the list — it must never open a row.
    if (!verticalRef.current && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
      verticalRef.current = true;
      setSwipeX(0);
      return;
    }
    if (verticalRef.current) return;

    const base = open ? SWIPE_OPEN_X : 0;
    setSwipeX(Math.max(SWIPE_OPEN_X, Math.min(0, base + dx)));
  };

  /** The browser took the gesture (a scroll, or the OS): drop it, unopened. */
  const onPointerCancel = () => {
    resetGesture();
    setSwipeX(open ? SWIPE_OPEN_X : 0);
  };

  const onPointerUp = () => {
    if (!coarse || !draggingRef.current) {
      resetGesture();
      return;
    }
    resetGesture();
    if (verticalRef.current) {
      setSwipeX(0);
      return;
    }
    const travelled = Math.abs(swipeX);
    if (travelled >= SWIPE_THRESHOLD) {
      onSwipeOpen(thread.id);
      setSwipeX(SWIPE_OPEN_X);
    } else {
      if (open) onSwipeOpen(null);
      setSwipeX(0);
    }
  };

  return (
    <li
      className="group relative flex items-start gap-1 overflow-hidden rounded-md"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      /* `pan-y` keeps the vertical scroll with the list and leaves horizontal
         travel to the swipe — with the default `auto` the scroller claims any
         drag and the browser fires pointercancel before the gesture can
         open a row. */
      style={coarse ? { touchAction: "pan-y" } : undefined}
      data-swipe-open={open ? "true" : undefined}
    >
      {/* The action revealed by the swipe. It sits BEHIND the row, so it is
          only reachable once the row has moved out of the way. */}
      {coarse && (
        <button
          type="button"
          data-testid="ask-thread-swipe-delete"
          aria-label={`Delete ${thread.title}`}
          title={`Delete ${thread.title}`}
          onClick={() => onRequestDelete(thread.id)}
          className="absolute inset-y-0 right-0 flex items-center gap-1 bg-destructive px-3 text-xs font-medium text-white"
        >
          <Trash2 className="size-3.5" />
          Delete
        </button>
      )}

      <div
        className="flex min-w-0 flex-1 items-start gap-1 bg-background transition-transform"
        style={coarse ? { transform: `translateX(${offset}px)` } : undefined}
      >
        <button
          type="button"
          onClick={() => {
            // Tapping the body of an open row closes it instead of opening
            // the thread.
            if (open) {
              onSwipeOpen(null);
              setSwipeX(0);
              return;
            }
            onOpen(thread.id);
          }}
          data-testid="ask-thread-item"
          data-thread-id={thread.id}
          data-group-id={thread.groupId ?? ""}
          title={thread.title}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
        >
          <MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            {/* A thread born in a group has no question yet: it takes the name
                of its first one. Until then it shows what it is. */}
            <span className="block truncate text-sm">
              {thread.title || "New ask"}
            </span>
            <span className="block text-xs text-muted-foreground">
              {thread.turnCount}{" "}
              {thread.turnCount === 1 ? "turn" : "turns"} ·{" "}
              {relativeTime(thread.updatedAt)}
            </span>
          </span>
        </button>

        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={() => setMoveOpen((value) => !value)}
            aria-label={`Move "${thread.title}" to another group`}
            title="Move to a group"
            data-testid="ask-thread-move"
          >
            <FolderKanban className="size-3.5" />
          </Button>
          {moveOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMoveOpen(false)} />
              <div
                className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
                data-testid="ask-move-menu"
              >
                <button
                  type="button"
                  onClick={() => {
                    setMoveOpen(false);
                    onMove(thread, null);
                  }}
                  data-testid="ask-move-none"
                  data-current={thread.groupId ? undefined : "true"}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                    !thread.groupId && "font-medium text-primary",
                  )}
                >
                  Uncategorized
                </button>
                {groups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => {
                      setMoveOpen(false);
                      onMove(thread, group.id);
                    }}
                    data-testid={`ask-move-${group.id}`}
                    data-current={thread.groupId === group.id ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                      thread.groupId === group.id && "font-medium text-primary",
                    )}
                  >
                    {group.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Always visible — hover only strengthens the colour, so the control
            is discoverable on desktop and reachable by keyboard. */}
        <button
          type="button"
          onClick={() => onRequestDelete(thread.id)}
          aria-label={`Delete "${thread.title}"`}
          title="Delete this research thread"
          data-testid="ask-thread-forget"
          className="rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

export default AskThreadList;
