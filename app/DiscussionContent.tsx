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
  result,
}: {
  discussionId: string | null;
  discussionName: string | null;
  history: PastResponse[];
  streamedResponse: string | null;
  streamedModel: string | null;
  isStreaming: boolean;
  result: string | null;
}) {
  return (
    <main>
      <h1>Execute tester</h1>
      {discussionId ? (
        // Falls back to the raw id only in the brief window before its
        // name has loaded (see useDiscussionExecution's discussionName) —
        // never a permanent display value.
        <p>Discussion: {discussionName ?? discussionId}</p>
      ) : (
        <p>No discussion selected — create or pick one above.</p>
      )}
      {discussionId && history.length > 0 && (
        <div>
          <h2>History</h2>
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
            Live response{isStreaming ? " (streaming...)" : ""}
            {streamedModel ? ` — ${streamedModel}` : ""}
          </h2>
          <MarkdownResponse content={streamedResponse} />
        </div>
      )}
      {result && <pre>{result}</pre>}
    </main>
  );
}
