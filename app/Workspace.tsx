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
// screenshot of the real app): the composer sits fixed near the top of
// the main panel, directly below the header, above the scrolling
// content — not a bottom-pinned footer. Header toolbar buttons
// (New Notebook/Settings/Account/Model) exist in their real fixed
// position but stay disabled/unwired -- their dialogs/behavior are
// separate, not-yet-built work. Import is wired (.pact import, see
// handleImportFileSelected); Export lives on each notebook row in
// Explorer.tsx, not in this header.
//
// The sidebar/main-panel split and its drag handle use
// react-resizable-panels (Group/Panel/Separator — this app's installed
// version, v4, renamed from the older PanelGroup/PanelResizeHandle names
// still shown in a lot of older docs/tutorials) rather than hand-rolled
// drag math: zero dependencies, 22M+ weekly downloads, published days
// before this was written. minSize/maxSize on the sidebar Panel are
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
  // Bumped whenever a discussion is created or a notebook is deleted, so
  // Explorer's effect refetches — it doesn't otherwise depend on anything
  // that changes here.
  const [discussionListRefetchToken, setDiscussionListRefetchToken] =
    useState(0);
  // Rebroadcast down to NotebookCreator, the same shape as
  // discussionListRefetchToken above — set here from Explorer's callback,
  // consumed by whichever child needs to react.
  const [lastDeletedNotebookId, setLastDeletedNotebookId] = useState<
    string | null
  >(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const execution = useDiscussionExecution(activeDiscussionId);

  function handleDiscussionCreated(discussionId: string) {
    setActiveDiscussionId(discussionId);
    setDiscussionListRefetchToken((t) => t + 1);
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
    setDiscussionListRefetchToken((t) => t + 1);
    setLastDeletedNotebookId(notebookId);
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
          onSelect={setActiveDiscussionId}
          onNotebookDeleted={handleNotebookDeleted}
          refetchToken={discussionListRefetchToken}
        />
        <hr />
        <NotebookCreator
          onDiscussionCreated={handleDiscussionCreated}
          lastDeletedNotebookId={lastDeletedNotebookId}
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
        <div style={{ flexShrink: 0 }}>
          <Composer
            discussionId={activeDiscussionId}
            promptText={execution.promptText}
            setPromptText={execution.setPromptText}
            loading={execution.loading}
            onSubmit={execution.handleSubmit}
          />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          <DiscussionContent
            discussionId={activeDiscussionId}
            discussionName={execution.discussionName}
            history={execution.history}
            streamedResponse={execution.streamedResponse}
            streamedModel={execution.streamedModel}
            isStreaming={execution.isStreaming}
            executionError={execution.executionError}
          />
        </div>
      </Panel>
    </Group>
  );
}
