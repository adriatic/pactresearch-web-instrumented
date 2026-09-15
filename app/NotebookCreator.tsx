"use client";

import { useRef, useState } from "react";

const CATEGORIES = ["Personal Research", "Dev Test"] as const;

export function NotebookCreator({
  onDiscussionCreated,
  lastDeletedNotebookId,
}: {
  onDiscussionCreated: (discussionId: string) => void;
  lastDeletedNotebookId: string | null;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>(
    CATEGORIES[0],
  );
  // Human-readable confirmation/error text — never the raw API response.
  // The full response is still visible in the browser's own network tab
  // for anyone who genuinely needs it; it doesn't need a second home in
  // this UI.
  const [notebookMessage, setNotebookMessage] = useState<string | null>(null);
  const [notebookLoading, setNotebookLoading] = useState(false);
  const [notebookId, setNotebookId] = useState<string | null>(null);

  const [discussionName, setDiscussionName] = useState("");
  const [discussionMessage, setDiscussionMessage] = useState<string | null>(
    null,
  );
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
      setNotebookMessage(null);
      setNotebookId(null);
      setDiscussionMessage(null);
      setDiscussionName("");
    }
  }

  async function handleCreateNotebook(e: React.FormEvent) {
    e.preventDefault();
    if (notebookInFlight.current) return;
    notebookInFlight.current = true;
    setNotebookLoading(true);
    setNotebookMessage(null);
    setNotebookId(null);

    try {
      const response = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, category }),
      });
      const body = await response.json();
      if (response.ok) {
        setNotebookMessage(`Notebook "${body.name}" created.`);
        setNotebookId(body.id);
      } else {
        setNotebookMessage(body.error || "Failed to create notebook.");
      }
    } catch {
      setNotebookMessage("Failed to create notebook — please try again.");
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
    setDiscussionMessage(null);

    try {
      const response = await fetch("/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notebookId, name: discussionName }),
      });
      const body = await response.json();
      if (response.ok) {
        setDiscussionMessage(`Discussion "${body.name}" created.`);
        onDiscussionCreated(body.id);
      } else {
        setDiscussionMessage(body.error || "Failed to create discussion.");
      }
    } catch {
      setDiscussionMessage("Failed to create discussion — please try again.");
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
      {notebookMessage && <p>{notebookMessage}</p>}

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
          {discussionMessage && <p>{discussionMessage}</p>}
        </>
      )}
    </section>
  );
}
