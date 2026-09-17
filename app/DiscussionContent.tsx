"use client";

import type { PastResponse } from "./useDiscussionExecution";
import { MarkdownResponse } from "./MarkdownResponse";

// The scrolling middle region of the fixed layout: the active
// discussion's identifier, its history, the live-streaming response, and
// the last run's raw result — everything from the old ExecuteTester
// except the composer, which now lives separately (Composer.tsx) in its
// own fixed position. Purely a rendering split for layout purposes; none
// of this content or its underlying state changed.

export function DiscussionContent({
  discussionId,
  discussionName,
  history,
  streamedResponse,
  streamedModel,
  streamedResponseCreatedAt,
  isStreaming,
  executionError,
}: {
  discussionId: string | null;
  discussionName: string | null;
  history: PastResponse[];
  streamedResponse: string | null;
  streamedModel: string | null;
  streamedResponseCreatedAt: string | null;
  isStreaming: boolean;
  executionError: string | null;
}) {
  return (
    <main>
      {discussionId ? (
        // Persistence audit finding E: previously fell back to the raw
        // id in the brief window before its name loaded (see
        // useDiscussionExecution's discussionName) -- self-correcting,
        // never a permanent display value, but still a uuid rendering as
        // identifying text for a moment. Replaced with a loading label
        // instead: nothing about this fix requires a raw id to ever
        // appear on screen, even transiently, and this audit's whole
        // premise is that identifying state showing something other than
        // its real value is worth closing even when it's brief.
        <p>Discussion: {discussionName ?? "Loading..."}</p>
      ) : (
        <p>No discussion selected — create or pick one above.</p>
      )}
      {discussionId && history.length > 0 && (
        <div>
          {history.map((entry) => (
            <div key={entry.id}>
              <p>
                <strong>Prompt:</strong> {entry.prompt_text}
              </p>
              <p>
                <strong>Response</strong>
                {entry.resolved_model ? ` — ${entry.resolved_model}` : ""}
                {/* Each entry's own created_at, not a single header-level
                    value -- 7986c92 originally put this on the
                    "Discussion:" line sourced from the *latest* response,
                    which stayed wrong for every older entry once you
                    scrolled past it. */}
                {` — ${new Date(entry.created_at).toLocaleString()}`}:
              </p>
              <MarkdownResponse content={entry.response ?? ""} />
            </div>
          ))}
        </div>
      )}
      {streamedResponse !== null && (
        <div>
          <h2>
            {isStreaming ? "Live response (streaming...)" : "Response"}
            {streamedModel ? ` — ${streamedModel}` : ""}
            {streamedResponseCreatedAt &&
              ` — ${new Date(streamedResponseCreatedAt).toLocaleString()}`}
          </h2>
          <MarkdownResponse content={streamedResponse} />
        </div>
      )}
      {executionError && <p>{executionError}</p>}
    </main>
  );
}
