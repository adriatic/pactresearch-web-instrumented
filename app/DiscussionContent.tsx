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
  isStreaming,
  executionError,
}: {
  discussionId: string | null;
  discussionName: string | null;
  history: PastResponse[];
  streamedResponse: string | null;
  streamedModel: string | null;
  isStreaming: boolean;
  executionError: string | null;
}) {
  // The most recently created response currently on screen -- history is
  // ordered oldest-first (see saveThenLoad's fetch), and a just-completed
  // run is appended to this same array as soon as it succeeds (see
  // run()'s history append), so the last entry is always the right one
  // to show a timestamp for, whether it arrived via a page load or a
  // run in the current session.
  const mostRecentResponse =
    history.length > 0 ? history[history.length - 1] : null;

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
        <p>
          Discussion: {discussionName ?? "Loading..."}
          {mostRecentResponse &&
            ` — Response: ${new Date(mostRecentResponse.created_at).toLocaleString()}`}
        </p>
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
                {entry.resolved_model ? ` — ${entry.resolved_model}` : ""}:
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
          </h2>
          <MarkdownResponse content={streamedResponse} />
        </div>
      )}
      {executionError && <p>{executionError}</p>}
    </main>
  );
}
