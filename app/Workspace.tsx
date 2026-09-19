"use client";

import { useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { NotebookCreator } from "./NotebookCreator";
import { Explorer } from "./Explorer";
import { Composer } from "./Composer";
import { DiscussionContent } from "./DiscussionContent";
import { useDiscussionExecution } from "./useDiscussionExecution";

function formatSwitchDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// Fixed-layout shell — opens the structural half of Phase D's port,
// alongside Explorer's tree view: a left sidebar (Explorer, its own
// independent scroll), a fixed header toolbar, a fixed composer, and a
// scrolling middle region for the active discussion's content. Ports
// pact-mac's actual App.tsx shell structure (confirmed against a
// screenshot of the real app): the composer sits near the top of the
// main panel, directly below the header, above the scrolling content —
// not a bottom-pinned footer. Header toolbar buttons
// (New Notebook/Settings/Account/Model) exist in their real fixed
// position but stay disabled/unwired -- their dialogs/behavior are
// separate, not-yet-built work. Run and Import are wired (Run acts on
// the selected discussion, see execution.run(); Import handles .pact
// files, see handleImportFileSelected); Export lives on each notebook
// row in Explorer.tsx, not in this header.
//
// Both splits — sidebar/main-panel, and composer/discussion-content —
// use react-resizable-panels (Group/Panel/Separator — this app's
// installed version, v4, renamed from the older PanelGroup/
// PanelResizeHandle names still shown in a lot of older docs/tutorials)
// rather than hand-rolled drag math: zero dependencies, 22M+ weekly
// downloads, published days before this was written. minSize/maxSize are
// plain pixel values — session-only, matching 3.13 decision 4's
// still-deferred persisted-UI-preference boundary (no localStorage/
// defaultLayout wiring here).
export function Workspace({
  initialDiscussionId,
}: {
  initialDiscussionId: string | null;
}) {
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(
    initialDiscussionId,
  );
  // Which notebook "Add a discussion to this notebook" (NotebookCreator)
  // targets -- the single source of truth for that, driven by whatever
  // the user actually selected: clicking a notebook row directly, or a
  // discussion (whose own parent counts too, see handleDiscussionSelected
  // below), or a notebook this session just created (see
  // handleNotebookCreated). Previously NotebookCreator tracked this
  // itself, from its own create-notebook success only -- meaning the
  // panel always targeted whichever notebook was most recently *created*
  // through that one form, silently ignoring any notebook the user
  // actually clicked afterward once two or more existed.
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(
    null,
  );
  // Bumped whenever a discussion is created or a notebook is deleted, so
  // Explorer's effect refetches — it doesn't otherwise depend on anything
  // that changes here.
  const [discussionListRefetchToken, setDiscussionListRefetchToken] =
    useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const execution = useDiscussionExecution(activeDiscussionId);

  function handleDiscussionCreated(discussionId: string) {
    setActiveDiscussionId(discussionId);
    setDiscussionListRefetchToken((t) => t + 1);
  }

  // A newly created notebook becomes the selected one -- immediately the
  // target for "Add a discussion to this notebook", without requiring a
  // separate click on its own row first.
  function handleNotebookCreated(notebookId: string) {
    setSelectedNotebookId(notebookId);
    setDiscussionListRefetchToken((t) => t + 1);
  }

  // Selecting a discussion also selects the notebook it lives in --
  // switching to a discussion inside Notebook B and then using "Add a
  // discussion" (without separately clicking B's own row) must target B,
  // not whatever was selected before.
  function handleDiscussionSelected(discussionId: string, notebookId: string) {
    setActiveDiscussionId(discussionId);
    setSelectedNotebookId(notebookId);
  }

  // Reads the selected .pact file, POSTs it to /api/notebooks/import (the
  // server does the real validation regardless of what's parsed here --
  // this is just an early, friendly error for "not even valid JSON"),
  // and refetches the tree so the new notebook appears. Resets the input
  // itself so selecting the exact same file again still fires onChange.
  async function handleImportFileSelected(
    e: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImportError(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setImportError("That file isn't valid JSON -- not a .pact file.");
        return;
      }

      const response = await fetch("/api/notebooks/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const body = await response.json();
      if (response.ok) {
        setDiscussionListRefetchToken((t) => t + 1);
      } else {
        setImportError(body.error || "Failed to import .pact file.");
      }
    } catch {
      setImportError("Failed to read the selected file.");
    }
  }

  function handleNotebookDeleted(
    notebookId: string,
    deletedDiscussionIds: string[],
  ) {
    if (
      activeDiscussionId &&
      deletedDiscussionIds.includes(activeDiscussionId)
    ) {
      setActiveDiscussionId(null);
    }
    // The deleted notebook can't stay the selected target for "Add a
    // discussion to this notebook" -- NotebookCreator's own render-time
    // reset (keyed on selectedNotebookId itself) picks this up and clears
    // its input/error the instant this commits, before it could ever
    // submit against a notebook that no longer exists.
    if (selectedNotebookId === notebookId) {
      setSelectedNotebookId(null);
    }
    setDiscussionListRefetchToken((t) => t + 1);
  }

  function handleDiscussionDeleted(discussionId: string) {
    if (activeDiscussionId === discussionId) {
      setActiveDiscussionId(null);
    }
    setDiscussionListRefetchToken((t) => t + 1);
  }

  return (
    <Group orientation="horizontal" style={{ height: "100vh" }}>
      <Panel
        defaultSize={280}
        minSize={180}
        maxSize={560}
        style={{ overflowY: "auto" }}
      >
        <Explorer
          activeDiscussionId={activeDiscussionId}
          onSelect={handleDiscussionSelected}
          onNotebookSelected={setSelectedNotebookId}
          onNotebookDeleted={handleNotebookDeleted}
          onDiscussionDeleted={handleDiscussionDeleted}
          refetchToken={discussionListRefetchToken}
        />
        <hr />
        <NotebookCreator
          selectedNotebookId={selectedNotebookId}
          onNotebookCreated={handleNotebookCreated}
          onDiscussionCreated={handleDiscussionCreated}
        />
      </Panel>
      <Separator
        style={{ width: 4, cursor: "col-resize", background: "#ccc" }}
      />
      <Panel
        style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <header style={{ flexShrink: 0 }}>
          <strong>PACT</strong>{" "}
          <button type="button" disabled>
            New Notebook
          </button>{" "}
          {/* Acts on whatever discussion is currently selected, using
              whatever text is in that discussion's composer. Disabled
              with no discussion selected (matching how the other header
              buttons gate on their own applicability) or with nothing
              worth running — execution.promptText is the same live state
              the composer's textarea is bound to, so this reacts to every
              keystroke and to a discussion switch's restored draft with
              no separate wiring. This is the sole run trigger — see
              Composer.tsx for why the composer no longer has one of its
              own. */}
          <button
            type="button"
            onClick={() => execution.run()}
            disabled={
              execution.loading ||
              !activeDiscussionId ||
              execution.promptText.trim().length === 0
            }
          >
            {execution.loading ? "Running..." : "Run"}
          </button>{" "}
          <button
            type="button"
            onClick={() => importFileInputRef.current?.click()}
          >
            Import
          </button>{" "}
          <input
            ref={importFileInputRef}
            type="file"
            accept=".pact"
            style={{ display: "none" }}
            onChange={handleImportFileSelected}
          />{" "}
          <button type="button" disabled>
            Settings
          </button>{" "}
          <button type="button" disabled>
            Account
          </button>{" "}
          <button type="button" disabled>
            Model
          </button>{" "}
          {execution.lastSwitchDurationMs !== null && (
            <span style={{ color: "#666", fontSize: "0.85em" }}>
              Switched in {formatSwitchDuration(execution.lastSwitchDurationMs)}
            </span>
          )}
          {importError && (
            <span style={{ color: "#a00", fontSize: "0.85em" }}>
              {" "}
              {importError}
            </span>
          )}
        </header>
        {/* The composer and the discussion content are their own vertical
            Group so the boundary between them is a real draggable
            divider, replacing the textarea's native corner resize grip
            (see Composer.tsx). Same library and same session-only,
            pixel-valued sizing as the sidebar split above — persisting
            this layout stays behind 3.13 decision 4. minHeight: 0 is
            what lets this Group actually shrink inside the surrounding
            flex column rather than being floored at its content height. */}
        <Group orientation="vertical" style={{ flex: 1, minHeight: 0 }}>
          <Panel defaultSize={140} minSize={64} maxSize={480}>
            <Composer
              promptText={execution.promptText}
              setPromptText={execution.setPromptText}
            />
          </Panel>
          <Separator
            style={{ height: 4, cursor: "row-resize", background: "#ccc" }}
          />
          <Panel style={{ overflowY: "auto" }}>
            <DiscussionContent
              discussionId={activeDiscussionId}
              discussionName={execution.discussionName}
              history={execution.history}
              streamedResponse={execution.streamedResponse}
              streamedModel={execution.streamedModel}
              streamedResponseCreatedAt={execution.streamedResponseCreatedAt}
              isStreaming={execution.isStreaming}
              executionError={execution.executionError}
            />
          </Panel>
        </Group>
      </Panel>
    </Group>
  );
}
