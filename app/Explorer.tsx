"use client";

import { useEffect, useRef, useState } from "react";
import {
  syncDataLoaderFeature,
  selectionFeature,
  hotkeysCoreFeature,
  type TreeState,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";

// Phase D's real notebook tree — ports the core behavior of pact-mac's
// Explorer.tsx (reviewed in full per 3.13 development-plan §3.13; the
// 340-line version, not the older 279-line one also found on disk) rather
// than redesigning: per-notebook expand/collapse, discussions nested
// underneath, selecting a discussion drives the active discussionId, and
// the notebook containing the active discussion auto-expands so a
// restored selection is never hidden behind a collapsed row. Deliberately
// not ported: export/import, the isSystem lock icon and hardcoded
// tutorial/drafts notebook IDs (3.13 decision 3's access-rights model
// replaces that, not yet built), persisted expand/collapse state (3.13
// decision 4, deferred — session-only is correct for now), and the inline
// "+ New Discussion" row (NotebookCreator already covers creation).
//
// Follow-up to 220474c: the hand-rolled "▼"/"▶" text-triangle link was
// unusable for real evaluation — no real tree control, no keyboard nav,
// no visual hierarchy. Rather than hand-build a real one, this uses
// @headless-tree (core + react bindings) — evaluated against
// react-arborist (pulls in redux + react-dnd, unneeded weight for a
// drag-free 2-level tree), react-accessible-treeview (its own README
// opens with "SEEKING NEW MAINTAINERS" — not actually well-maintained
// despite download counts), and react-complex-tree (headless-tree is
// that library's own official successor, from the same author). Chosen
// for: zero runtime dependencies, genuinely headless (no imposed CSS —
// this project has no CSS framework), and active development. Its
// "beta" label is a real caveat, worth noting, but beta-and-actively-
// developed beat stable-but-orphaned here. Delete controls' visual
// treatment is still explicitly out of scope for this task.

interface Notebook {
  id: string;
  name: string | null;
}

interface Discussion {
  id: string;
  notebook_id: string;
  name: string | null;
}

type TreeNodeData =
  | { kind: "root" }
  | { kind: "notebook"; notebookId: string; name: string }
  | {
      kind: "discussion";
      discussionId: string;
      notebookId: string;
      name: string;
    }
  | { kind: "empty-placeholder" };

function fetchNotebooks(): Promise<Notebook[]> {
  return fetch("/api/notebooks").then((response) => response.json());
}

function fetchDiscussions(): Promise<Discussion[]> {
  return fetch("/api/discussions").then((response) => response.json());
}

const ROOT_ID = "__explorer_root__";

// Session-only expand/collapse persistence: survives a same-tab reload
// (this bug's actual bar — it didn't even do that before) without
// reaching for the database or surviving across tabs/devices, which
// stays out of scope per 3.13 decision 4. sessionStorage rather than
// localStorage specifically because it's scoped to the one tab/session.
const EXPANDED_ITEMS_STORAGE_KEY = "pact:explorer:expandedItems";

function readPersistedExpandedItems(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(EXPANDED_ITEMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function persistExpandedItems(expandedItems: string[]) {
  try {
    window.sessionStorage.setItem(
      EXPANDED_ITEMS_STORAGE_KEY,
      JSON.stringify(expandedItems),
    );
  } catch {
    // Best-effort — a full session store or disabled storage shouldn't
    // break the tree itself, just the persistence of its state.
  }
}

export function Explorer({
  activeDiscussionId,
  onSelect,
  onNotebookDeleted,
  refetchToken,
}: {
  activeDiscussionId: string | null;
  onSelect: (discussionId: string) => void;
  onNotebookDeleted: (
    notebookId: string,
    deletedDiscussionIds: string[],
  ) => void;
  refetchToken: number;
}) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchNotebooks(), fetchDiscussions()]).then(
      ([notebooksBody, discussionsBody]) => {
        if (!cancelled) {
          setNotebooks(notebooksBody);
          setDiscussions(discussionsBody);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [refetchToken]);

  async function handleDeleteNotebook(notebookId: string, name: string) {
    const confirmed = window.confirm(
      `Delete notebook "${name}" and all its discussions? This cannot be undone.`,
    );
    if (!confirmed) return;

    const deletedDiscussionIds = discussions
      .filter((d) => d.notebook_id === notebookId)
      .map((d) => d.id);

    setDeleteError(null);
    const response = await fetch(`/api/notebooks?id=${notebookId}`, {
      method: "DELETE",
    });

    if (response.ok) {
      onNotebookDeleted(notebookId, deletedDiscussionIds);
    } else if (response.status === 409) {
      setDeleteError(
        `"${name}" can't be deleted right now — a discussion in it is actively executing. Try again once that finishes.`,
      );
    } else {
      setDeleteError(`Failed to delete "${name}".`);
    }
  }

  // Downloads the notebook as a .pact file -- a plain JSON file (ported
  // from pact-mac's export format, unsigned, minus desktop-only xmState)
  // that importNotebook() can turn back into a fully independent notebook
  // instance. The file itself is fetched and blobbed client-side rather
  // than navigated to directly, matching every other action in this
  // component being a fetch() call.
  async function handleExportNotebook(notebookId: string, name: string) {
    setExportError(null);
    const response = await fetch(`/api/notebooks/export?id=${notebookId}`);
    if (!response.ok) {
      setExportError(`Failed to export "${name}".`);
      return;
    }
    const pactExport = await response.json();
    const blob = new Blob([JSON.stringify(pactExport, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    // Same sanitization concern as any user-provided string ending up in
    // a filename -- strip anything that isn't safe across filesystems,
    // collapse the rest to single hyphens.
    const safeName = name
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
    link.download = `${safeName || "notebook"}.pact`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Tracks the tree's own last-seen state so setState below can resolve
  // the updater-function form of SetStateFn's Updater<T> union — in
  // practice @headless-tree/react always calls setState with a direct
  // value, never a function, but the declared type allows either.
  const lastTreeStateRef = useRef<Partial<TreeState<TreeNodeData>>>({});

  const tree = useTree<TreeNodeData>({
    rootItemId: ROOT_ID,
    getItemName: (item) => {
      const data = item.getItemData();
      switch (data.kind) {
        case "notebook":
        case "discussion":
          return data.name;
        case "empty-placeholder":
          return "No discussions yet.";
        default:
          return "";
      }
    },
    isItemFolder: (item) => item.getItemData().kind === "notebook",
    dataLoader: {
      getItem: (itemId) => {
        if (itemId === ROOT_ID) return { kind: "root" };
        if (itemId.endsWith("::empty")) return { kind: "empty-placeholder" };
        const notebook = notebooks.find((n) => n.id === itemId);
        if (notebook) {
          return {
            kind: "notebook",
            notebookId: notebook.id,
            name: notebook.name || notebook.id,
          };
        }
        const discussion = discussions.find((d) => d.id === itemId);
        if (discussion) {
          return {
            kind: "discussion",
            discussionId: discussion.id,
            notebookId: discussion.notebook_id,
            name: discussion.name || discussion.id,
          };
        }
        return { kind: "root" };
      },
      getChildren: (itemId) => {
        if (itemId === ROOT_ID) return notebooks.map((n) => n.id);
        const isNotebook = notebooks.some((n) => n.id === itemId);
        if (!isNotebook) return [];
        const childDiscussionIds = discussions
          .filter((d) => d.notebook_id === itemId)
          .map((d) => d.id);
        // A notebook with zero discussions still gets a row — a synthetic
        // placeholder child rather than an empty children array, since
        // this data model has no other way to render "No discussions
        // yet." under an expanded, empty notebook.
        return childDiscussionIds.length > 0
          ? childDiscussionIds
          : [`${itemId}::empty`];
      },
    },
    indent: 20,
    onPrimaryAction: (item) => {
      const data = item.getItemData();
      if (data.kind === "discussion") {
        onSelect(data.discussionId);
      }
    },
    // Seeds expandedItems from sessionStorage on mount (read once, via a
    // lazy initializer, not on every render), then persists it back on
    // every tree state change. This only observes and mirrors
    // expandedItems out to storage — it doesn't take over as the
    // source of truth the way a fully-controlled `state` prop would, so
    // the auto-expand effect below (and the tree's own internal click
    // handling) keep working exactly as before; they still just call
    // item.expand()/collapse() and this tags along.
    initialState: { expandedItems: readPersistedExpandedItems() },
    setState: (updaterOrValue) => {
      const state =
        typeof updaterOrValue === "function"
          ? updaterOrValue(lastTreeStateRef.current)
          : updaterOrValue;
      lastTreeStateRef.current = state;
      if (state.expandedItems) persistExpandedItems(state.expandedItems);
    },
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  // The sync data loader retrieves item/children data once and caches it
  // internally — rebuildTree() is headless-tree's own documented way to
  // tell it the underlying data changed (a notebook/discussion created or
  // deleted) and it should recompute rather than keep showing stale data.
  useEffect(() => {
    tree.rebuildTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebooks, discussions]);

  // A restored/selected discussion must never be invisible behind a
  // collapsed row — ports pact-react-v3's fix for the same gap (first
  // applied in this app's b8ca74e). Split in two: which notebook needs
  // expanding is decided during render (the same "adjust state when a
  // prop changes" pattern used elsewhere in this app), but handed to the
  // effect via *state*, not a local variable — calling setState during
  // render makes React immediately discard and restart that render (its
  // documented behavior for this exact pattern), so a plain local
  // variable computed in the discarded render never survives to reach a
  // committed effect. pendingAutoExpandNotebookId is state specifically
  // so it survives the restart. The actual tree.expand() call is a
  // genuinely imperative call into an external, non-React-state library,
  // which a useEffect is the correct place for — not working around
  // react-hooks/set-state-in-effect, but a real "synchronize with an
  // external system" case. Not reset back to null afterward: the effect
  // is keyed on this value specifically, so it only re-fires when a new
  // auto-expand is genuinely due, whether or not the old value is cleared.
  const [autoExpandedForDiscussionId, setAutoExpandedForDiscussionId] =
    useState<string | null>(null);
  const [pendingAutoExpandNotebookId, setPendingAutoExpandNotebookId] =
    useState<string | null>(null);
  if (activeDiscussionId !== autoExpandedForDiscussionId) {
    const discussion = discussions.find((d) => d.id === activeDiscussionId);
    // discussions hasn't loaded yet — don't mark handled, so this retries
    // once it has (this render-time check re-runs on every render where
    // discussions has changed).
    if (discussion) {
      setAutoExpandedForDiscussionId(activeDiscussionId);
      setPendingAutoExpandNotebookId(discussion.notebook_id);
    }
  }

  useEffect(() => {
    if (!pendingAutoExpandNotebookId) return;
    const notebookItem = tree.getItemInstance(pendingAutoExpandNotebookId);
    if (notebookItem && !notebookItem.isExpanded()) {
      notebookItem.expand();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoExpandNotebookId]);

  return (
    <section>
      <h2>Explorer</h2>
      {deleteError && <p>{deleteError}</p>}
      {exportError && <p>{exportError}</p>}
      <div {...tree.getContainerProps("Explorer")}>
        {tree.getItems().map((item) => {
          const data = item.getItemData();
          const level = item.getItemMeta().level;
          const paddingLeft = 8 + level * 20;

          if (data.kind === "root") return null;

          if (data.kind === "empty-placeholder") {
            return (
              <div
                key={item.getId()}
                style={{
                  padding: `2px 8px 2px ${paddingLeft}px`,
                  color: "#888",
                }}
              >
                No discussions yet.
              </div>
            );
          }

          if (data.kind === "notebook") {
            const isExpanded = item.isExpanded();
            return (
              <div
                key={item.getId()}
                {...item.getProps()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: `4px 8px 4px ${paddingLeft}px`,
                  cursor: "pointer",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: "1em", fontSize: "0.75em" }}
                >
                  {isExpanded ? "▼" : "▶"}
                </span>
                <span aria-hidden="true">📓</span>
                <h3 style={{ margin: 0, fontSize: "1em", flex: 1 }}>
                  {data.name}
                </h3>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleExportNotebook(data.notebookId, data.name);
                  }}
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteNotebook(data.notebookId, data.name);
                  }}
                >
                  Delete notebook
                </button>
              </div>
            );
          }

          // data.kind === "discussion"
          const isActive = data.discussionId === activeDiscussionId;
          return (
            <div
              key={item.getId()}
              {...item.getProps()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: `2px 8px 2px ${paddingLeft}px`,
                cursor: "pointer",
                fontWeight: isActive ? "bold" : "normal",
              }}
            >
              <span aria-hidden="true">💬</span>
              <span>{data.name}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
