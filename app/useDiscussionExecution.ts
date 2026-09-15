import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";

// All of ExecuteTester's state/effects/run(), unchanged, extracted
// into a hook so the fixed-layout shell (Workspace.tsx) can render the
// discussion content and the composer as two separately-positioned
// components — a scrolling middle region and a pinned footer — while both
// share this one live state instance. This is purely a structural split
// for layout purposes; none of the composer's actual behavior changes
// here (that rebuild is 3.13 decision 1's exempted, separately-prototyped
// project, not part of pact-web).

export interface PastResponse {
  id: string;
  prompt_text: string;
  response: string | null;
  resolved_model: string | null;
}

interface DiscussionRow {
  id: string;
  name: string | null;
  draft_prompt_text: string | null;
}

export function useDiscussionExecution(discussionId: string | null) {
  const [promptText, setPromptText] = useState("");
  // Human-readable error text only — never the raw API error payload. Set
  // on a failed run (from /api/execute's { error, errorId } body, or a
  // thrown network error) and cleared at the start of every new run and
  // on discussion switch.
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamedResponse, setStreamedResponse] = useState<string | null>(null);
  const [streamedModel, setStreamedModel] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [history, setHistory] = useState<PastResponse[]>([]);
  // The active discussion's own name, loaded alongside its draft — real
  // persisted data fetched by the same effect below, same reasoning as
  // promptText/history (see the comment above displayedDiscussionId).
  const [discussionName, setDiscussionName] = useState<string | null>(null);
  // Wall-clock time the most recent switch (or initial load) took, from the
  // moment discussionId changed to the moment content + composer draft were
  // both rendered. Set once, at the end of the effect below — not on every
  // intermediate state update — so it reflects the full round trip.
  const [lastSwitchDurationMs, setLastSwitchDurationMs] = useState<
    number | null
  >(null);

  // Non-persisted live-run display state — cleared immediately, during
  // render, the moment discussionId changes, so a previous discussion's
  // response never flashes next to a different (or absent) active
  // discussion. Adjusted directly during render, same pattern as
  // NotebookCreator's deleted-notebook clear: an effect calling setState
  // synchronously in its body here would trigger an avoidable extra
  // render pass (react-hooks/set-state-in-effect). promptText and history
  // used to be reset here too (see 4d64d02) — they're real persisted data
  // now (see the effect below), not in-memory state that needs resetting.
  const [displayedDiscussionId, setDisplayedDiscussionId] =
    useState(discussionId);
  if (discussionId !== displayedDiscussionId) {
    setDisplayedDiscussionId(discussionId);
    setExecutionError(null);
    setStreamedResponse(null);
    setStreamedModel(null);
    setIsStreaming(false);
  }

  // Always holds the latest promptText, readable from the effect below
  // without a stale closure — promptText changes on every keystroke, but
  // that effect only re-runs when discussionId itself changes.
  const promptTextRef = useRef(promptText);
  useEffect(() => {
    promptTextRef.current = promptText;
  }, [promptText]);

  // Which discussion is currently "claimed" as active by this effect —
  // the outgoing discussion to save the draft against on the next switch.
  // Claimed synchronously at the very start of each effect invocation
  // (inside the effect, before any await — not during render, so this
  // isn't subject to the render-time ref-write restriction), not only
  // after a load fully completes. That distinction matters: if it were
  // only updated on load completion, a second switch that starts before
  // the first one's load has finished would still see the *original*
  // discussion as outgoing, never learning the first switch ever
  // happened — exactly the bug this fixes. null on first mount.
  const activeDiscussionIdRef = useRef<string | null>(null);

  // Single source of truth for both history and the persisted draft:
  // switching discussions saves the outgoing discussion's draft first —
  // awaited, so switching back can't observe a lost save racing against
  // the incoming discussion's load — then loads the new discussion's
  // history and persisted draft. Nothing here is a special-cased
  // in-memory value; it's real data, fetched and saved through the
  // database like everything else in this component.
  useEffect(() => {
    let cancelled = false;

    async function saveThenLoad() {
      // Captured at the very top, before the outgoing-draft save — the
      // switch is "selected" the instant discussionId changes, and that
      // save is part of the switch's cost, not a separate step.
      const switchStartedAt = performance.now();
      const outgoingDiscussionId = activeDiscussionIdRef.current;
      const outgoingDraft = promptTextRef.current;
      activeDiscussionIdRef.current = discussionId;

      // outgoingDiscussionId === discussionId means this invocation isn't
      // a genuine switch — either the very first claim for this target,
      // or React Strict Mode's dev-only second invocation of the same
      // target (the first invocation already claimed it). Only a real
      // mismatch is a genuine outgoing discussion to save.
      if (outgoingDiscussionId && outgoingDiscussionId !== discussionId) {
        await fetch(`/api/discussions?id=${outgoingDiscussionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ draftPromptText: outgoingDraft || null }),
        });
      }

      if (cancelled) return;

      if (!discussionId) {
        setPromptText("");
        setHistory([]);
        setDiscussionName(null);
        setLastSwitchDurationMs(performance.now() - switchStartedAt);
        return;
      }

      const [historyBody, discussionsBody] = await Promise.all([
        fetch(`/api/responses?discussionId=${discussionId}`).then((r) =>
          r.json(),
        ),
        fetch(`/api/discussions?id=${discussionId}`).then((r) => r.json()),
      ]);

      if (cancelled) return;

      setHistory(historyBody);
      const loadedDiscussion = (discussionsBody as DiscussionRow[])[0];
      setPromptText(loadedDiscussion?.draft_prompt_text ?? "");
      setDiscussionName(loadedDiscussion?.name ?? null);
      // This still measures state being set, not paint — React commits the
      // corresponding DOM update in the very next (synchronous, no
      // network/timer in between) render, so it's a close-enough proxy for
      // "content and composer draft fully rendered" without needing a
      // useLayoutEffect/rAF round trip just to time a diagnostic.
      setLastSwitchDurationMs(performance.now() - switchStartedAt);
    }

    saveThenLoad();

    return () => {
      cancelled = true;
    };
  }, [discussionId]);

  // Takes no event: the Run control lives in the global header
  // (Workspace.tsx), not inside the composer's form, so there is no
  // submit event to preventDefault here.
  async function run() {
    if (!discussionId) return;
    setLoading(true);
    setExecutionError(null);
    setStreamedResponse(null);
    setStreamedModel(null);
    setIsStreaming(false);

    const supabase = createClient();
    // Which responses row this run is watching — captured from the first
    // INSERT event, so later UPDATE events for some *other* response on
    // this discussion (a future run) don't get applied to this display.
    // This is a best-effort live preview only: /api/execute's own fetch
    // below blocks until the full response is ready and always carries
    // the authoritative final text, so a Realtime hiccup (a dropped
    // event, a subscription that never delivers) can only cost the user
    // the in-progress preview, never the completed response itself.
    let watchedRowId: string | null = null;

    const channel = supabase
      .channel(`responses-${discussionId}-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "responses",
          filter: `discussion_id=eq.${discussionId}`,
        },
        (payload) => {
          if (watchedRowId) return;
          watchedRowId = payload.new.id;
          setStreamedModel(payload.new.resolved_model ?? null);
          setStreamedResponse(payload.new.response ?? "");
          setIsStreaming(true);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "responses",
          filter: `discussion_id=eq.${discussionId}`,
        },
        (payload) => {
          if (!watchedRowId || payload.new.id !== watchedRowId) return;
          setStreamedResponse(payload.new.response ?? "");
        },
      );

    try {
      // Wait for the subscription to actually be established before
      // firing the POST — otherwise the earliest INSERT (message_start)
      // could land before anything is listening for it.
      await new Promise<void>((resolve, reject) => {
        channel.subscribe((status, err) => {
          if (status === "SUBSCRIBED") {
            resolve();
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            reject(err ?? new Error(`Realtime subscription failed: ${status}`));
          }
        });
      });

      const response = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ discussionId, promptText }),
      });
      const body = await response.json();

      if (response.ok) {
        // Authoritative final content, independent of whether the
        // Realtime preview above ever delivered anything.
        setStreamedResponse(body.response ?? "");
        setStreamedModel(body.resolved_model ?? null);

        // The draft was just promoted into a real cell — clear its
        // persisted copy so switching away and back doesn't resurrect
        // it. Best-effort: a failure here shouldn't overwrite the run's
        // own result with an unrelated cleanup error.
        try {
          await fetch(`/api/discussions?id=${discussionId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ draftPromptText: null }),
          });
        } catch {
          // Best-effort cleanup — see comment above.
        }
      } else {
        setExecutionError(
          body.errorId
            ? `${body.error} (error id: ${body.errorId})`
            : body.error,
        );
      }
    } catch (err) {
      setExecutionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setIsStreaming(false);
      await supabase.removeChannel(channel);
    }
  }

  return {
    promptText,
    setPromptText,
    executionError,
    loading,
    streamedResponse,
    streamedModel,
    isStreaming,
    history,
    run,
    lastSwitchDurationMs,
    discussionName,
  };
}
