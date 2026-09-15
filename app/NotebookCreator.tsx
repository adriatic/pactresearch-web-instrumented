"use client";

import { useRef, useState } from "react";

const CATEGORIES = ["Personal Research", "Dev Test"] as const;

interface ExistingDiscussion {
  notebook_id: string;
  name: string | null;
}

export function NotebookCreator({
  onNotebookCreated,
  onDiscussionCreated,
  lastDeletedNotebookId,
}: {
  onNotebookCreated: () => void;
  onDiscussionCreated: (discussionId: string) => void;
  lastDeletedNotebookId: string | null;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>(
    CATEGORIES[0],
  );
  // Errors only. Success confirmations used to live here too ("Notebook
  // \"X\" created."), but the notebook/discussion appearing in the
  // Explorer tree is already the confirmation — a second textual one said
  // nothing the tree didn't.
  const [notebookError, setNotebookError] = useState<string | null>(null);
  const [notebookLoading, setNotebookLoading] = useState(false);
  const [notebookId, setNotebookId] = useState<string | null>(null);

  const [discussionName, setDiscussionName] = useState("");
  const [discussionError, setDiscussionError] = useState<string | null>(null);
  const [discussionLoading, setDiscussionLoading] = useState(false);

  // Refs, not state, so the guard is checked synchronously at the top of
  // the handler — closing the narrow window where a second click can fire
  // before React has committed the disabled-button re-render from the
  // first one.
  const notebookInFlight = useRef(false);
  const discussionInFlight = useRef(false);

  // Clears this component's own leftover display when the notebook it
  // describes was just deleted elsewhere (DiscussionList's delete button,
  // wired up via Workspace) — not on every delete, only when it's the one
  // this component is currently showing. Adjusted directly during render
  // (React's recommended pattern for "reset state when a prop changes"),
  // not in an effect — an effect here would setState synchronously in its
  // body, triggering an extra, avoidable render pass.
  const [handledDeletedNotebookId, setHandledDeletedNotebookId] = useState<
    string | null
  >(null);
  if (lastDeletedNotebookId !== handledDeletedNotebookId) {
    setHandledDeletedNotebookId(lastDeletedNotebookId);
    if (lastDeletedNotebookId && lastDeletedNotebookId === notebookId) {
      setNotebookError(null);
      setNotebookId(null);
      setDiscussionError(null);
      setDiscussionName("");
    }
  }

  async function handleCreateNotebook(e: React.FormEvent) {
    e.preventDefault();
    if (notebookInFlight.current) return;
    notebookInFlight.current = true;
    setNotebookLoading(true);
    setNotebookError(null);
    setNotebookId(null);

    try {
      const response = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, category }),
      });
      const body = await response.json();
      if (response.ok) {
        setNotebookId(body.id);
        // The Explorer tree is now the *only* confirmation a notebook was
        // created (the "Notebook \"X\" created." message is gone), so it
        // has to actually refresh — it previously only refetched when a
        // discussion was created or a notebook deleted, leaving a newly
        // created notebook invisible until something else happened to
        // trigger a refetch.
        onNotebookCreated();
      } else {
        setNotebookError(body.error || "Failed to create notebook.");
      }
    } catch {
      setNotebookError("Failed to create notebook — please try again.");
    } finally {
      setNotebookLoading(false);
      notebookInFlight.current = false;
    }
  }

  async function handleCreateDiscussion(e: React.FormEvent) {
    e.preventDefault();
    if (!notebookId || discussionInFlight.current) return;
    discussionInFlight.current = true;
    setDiscussionLoading(true);
    setDiscussionError(null);

    try {
      // UI-level uniqueness check only — there is deliberately no schema
      // constraint behind this, and it is scoped to this one notebook:
      // the same discussion name in a *different* notebook is fine. Read
      // fresh from the server rather than trusting anything cached here,
      // so a discussion added since this panel opened still counts.
      // Compared trimmed and case-insensitively: "Baseline" vs
      // "baseline " is the duplicate a user actually means to be warned
      // about, not a distinct name.
      const existingResponse = await fetch("/api/discussions");
      if (existingResponse.ok) {
        const existing = (await existingResponse.json()) as
          ExistingDiscussion[] | null;
        const normalized = discussionName.trim().toLowerCase();
        const isDuplicate = (existing ?? []).some(
          (discussion) =>
            discussion.notebook_id === notebookId &&
            (discussion.name ?? "").trim().toLowerCase() === normalized,
        );
        if (isDuplicate) {
          setDiscussionError(
            `This notebook already has a discussion named "${discussionName.trim()}". Pick a different name.`,
          );
          return;
        }
      }

      const response = await fetch("/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notebookId, name: discussionName }),
      });
      const body = await response.json();
      if (response.ok) {
        onDiscussionCreated(body.id);
      } else {
        setDiscussionError(body.error || "Failed to create discussion.");
      }
    } catch {
      setDiscussionError("Failed to create discussion — please try again.");
    } finally {
      setDiscussionLoading(false);
      discussionInFlight.current = false;
    }
  }

  return (
    <section>
      <h1>Notebook creator</h1>
      <form onSubmit={handleCreateNotebook}>
        <label>
          Name:{" "}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <br />
        <label>
          Category:{" "}
          <select
            value={category}
            onChange={(e) =>
              setCategory(e.target.value as (typeof CATEGORIES)[number])
            }
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <br />
        <button type="submit" disabled={notebookLoading}>
          {notebookLoading ? "Creating..." : "Create notebook"}
        </button>
      </form>
      {notebookError && <p>{notebookError}</p>}

      {notebookId && (
        <>
          <h2>Add a discussion to this notebook</h2>
          <form onSubmit={handleCreateDiscussion}>
            <label>
              Name:{" "}
              <input
                type="text"
                value={discussionName}
                onChange={(e) => setDiscussionName(e.target.value)}
                required
              />
            </label>
            <br />
            <button type="submit" disabled={discussionLoading}>
              {discussionLoading ? "Creating..." : "Create discussion"}
            </button>
          </form>
          {discussionError && <p>{discussionError}</p>}
        </>
      )}
    </section>
  );
}
