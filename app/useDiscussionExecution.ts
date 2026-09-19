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
  created_at: string;
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
  const [streamedResponseCreatedAt, setStreamedResponseCreatedAt] = useState<
    string | null
  >(null);
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
    setStreamedResponseCreatedAt(null);
    setIsStreaming(false);
  }

  // Always holds the latest promptText, readable from the effect below
  // without a stale closure — promptText changes on every keystroke, but
  // that effect only re-runs when discussionId itself changes.
  const promptTextRef = useRef(promptText);

  // Which discussion's own content promptText currently, genuinely
  // represents — distinct from activeDiscussionIdRef below, which tracks
  // which discussion is *claimed* as outgoing regardless of whether the
  // user (or its own load) ever actually produced real content for it.
  // Updated below, alongside promptTextRef, to activeDiscussionIdRef's
  // *current* value every time promptText actually changes for any
  // reason — the user typing (by far the common case: the composer's
  // onChange fires setPromptText directly, with no connection to
  // saveThenLoad at all) just as much as a load completing or run()'s
  // post-success clear. Deliberately not narrower (e.g. only updated from
  // saveThenLoad's own completion): an earlier version of this fix did
  // that and broke the single most basic case it needed to preserve --
  // typing a real draft into a discussion whose own background load
  // hadn't technically finished yet still got silently dropped on the
  // next switch, because nothing had ever marked that discussion as the
  // content's genuine owner. What this guards against is the opposite,
  // rarer case: switching through several discussions fast enough that
  // an intermediate one's own load is interrupted *and* the user never
  // typed anything into it either -- then promptText never changes while
  // it's nominally active, this ref is never touched, and it keeps
  // pointing at whichever discussion's content is still actually
  // displayed. null when promptText represents nothing real yet (initial
  // mount, or no discussion selected).
  const promptTextOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    promptTextRef.current = promptText;
    promptTextOwnerRef.current = activeDiscussionIdRef.current;
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

  // The most recently fired outgoing-draft-save request, if it might
  // still be in flight — shared across every invocation of the effect
  // below, not local to any one of them. Needed for a real, confirmed
  // race: switch away from a discussion (firing its outgoing save),
  // then switch straight back before that save has actually landed. The
  // switch-back's own invocation has nothing new to save (the discussion
  // it's leaving never had its own load validated — see
  // outgoingDraftIsValid below), so it always used to proceed straight
  // to reloading the discussion being returned to — racing ahead of the
  // still-in-flight save and reading the *pre-save* draft_prompt_text,
  // showing an empty composer even though the save goes on to succeed a
  // moment later. Nothing ever re-synced afterward, so the empty
  // composer was permanent until another switch happened to reload it
  // correctly. Confirmed locally with artificial latency (local dev's
  // near-zero round trips otherwise make this exact window very hard to
  // land in) matching real production timing, where an ordinary,
  // unhurried switch-away-and-back is well within reach of this window.
  const pendingOutgoingSaveRef = useRef<Promise<unknown> | null>(null);

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
      // True only if promptText's current value genuinely belongs to
      // outgoingDiscussionId (its own completed load, a user keystroke
      // typed while it was active, or its own run() clear) — not
      // leftover from whichever discussion was active before it, which
      // happens when this same discussion is switched away from again
      // before its own saveThenLoad ever got a chance to load its data
      // *and* the user never typed anything into it either. Saving in
      // that case would silently overwrite this discussion's real,
      // correct draft (typically null/none) with someone else's
      // unrelated content.
      const outgoingDraftIsValid =
        promptTextOwnerRef.current === outgoingDiscussionId;
      activeDiscussionIdRef.current = discussionId;

      // outgoingDiscussionId === discussionId means this invocation isn't
      // a genuine switch — either the very first claim for this target,
      // or React Strict Mode's dev-only second invocation of the same
      // target (the first invocation already claimed it). Only a real
      // mismatch is a genuine outgoing discussion to save.
      if (
        outgoingDiscussionId &&
        outgoingDiscussionId !== discussionId &&
        outgoingDraftIsValid
      ) {
        const savePromise = fetch(
          `/api/discussions?id=${outgoingDiscussionId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ draftPromptText: outgoingDraft || null }),
          },
        );
        pendingOutgoingSaveRef.current = savePromise;
        await savePromise;
      } else if (pendingOutgoingSaveRef.current) {
        // This invocation has nothing of its own to save, but an earlier
        // switch's own save may still be in flight -- wait for it before
        // reading anything below. Otherwise a fast switch-away-then-back
        // (this invocation is exactly that: outgoingDraftIsValid is false
        // because the discussion being left never had its own load
        // validated) can read stale, pre-save data. Harmless to wait on
        // even when the pending save targets some other discussion
        // entirely -- it's already resolved or resolving regardless, so
        // this never blocks on work that wasn't already happening.
        await pendingOutgoingSaveRef.current;
      }

      if (cancelled) return;

      if (!discussionId) {
        setPromptText("");
        promptTextOwnerRef.current = null;
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
      // An actual unsent draft always wins — it may well differ from any
      // cell's prompt (the user started typing something new). Absent
      // one, fall back to the most recently run cell's own prompt_text
      // (history is ordered oldest-first, so the last entry is the most
      // recent) rather than leaving the composer blank. Without this, any
      // discussion loaded fresh — a normal switch/reload after a
      // successful run clears draft_prompt_text by design (see run()'s
      // cleanup below), and an imported discussion never had one to begin
      // with — showed an empty composer despite the exact text being
      // sitting right there in its own history. draft_prompt_text can
      // only ever be a non-empty string or null (the switch-save below
      // uses `|| null`, never persisting ""), so `??` alone is enough to
      // tell "no draft" from "an intentionally short draft".
      const lastCellPromptText =
        historyBody.length > 0
          ? (historyBody[historyBody.length - 1] as PastResponse).prompt_text
          : null;
      setPromptText(
        loadedDiscussion?.draft_prompt_text ?? lastCellPromptText ?? "",
      );
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
    // Fixed for this call — read once, up front, distinct from
    // promptTextRef.current below, which keeps tracking live edits made
    // while this run is in flight (the composer isn't disabled during a
    // run).
    const submittedPromptText = promptText;
    setLoading(true);
    setExecutionError(null);
    setStreamedResponse(null);
    setStreamedModel(null);
    setStreamedResponseCreatedAt(null);
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
          setStreamedResponseCreatedAt(payload.new.created_at ?? null);
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
        body: JSON.stringify({ discussionId, promptText: submittedPromptText }),
      });
      const body = await response.json();

      if (response.ok) {
        // Authoritative final content, independent of whether the
        // Realtime preview above ever delivered anything.
        setStreamedResponse(body.response ?? "");
        setStreamedModel(body.resolved_model ?? null);
        setStreamedResponseCreatedAt(body.response_created_at ?? null);

        // Reflects the just-completed run directly into history, rather
        // than leaving it visible only via the "Live response" section
        // above (itself overwritten by the *next* run) until some later,
        // unrelated discussion switch happens to refetch it (persistence
        // audit finding A). Guarded on discussionId still matching the
        // currently active one: nothing prevents switching away from
        // this discussion before its own run resolves, and appending to
        // whatever discussion's history is on screen *now* would put
        // this entry under the wrong one. history's own state naturally
        // gets replaced wholesale by the authoritative fetch on the next
        // real load of this discussion (switch or reload), so this is
        // strictly an earlier, same-session view of the same eventual
        // data, never a second, conflicting source of truth for it.
        if (
          body.response_row_id &&
          body.response_created_at &&
          discussionId === activeDiscussionIdRef.current
        ) {
          setHistory((prev) => [
            ...prev,
            {
              id: body.response_row_id,
              prompt_text: submittedPromptText,
              response: body.response ?? "",
              resolved_model: body.resolved_model ?? null,
              created_at: body.response_created_at,
            },
          ]);
        }

        // The draft was just promoted into a real cell — clear both its
        // persisted copy (below) and the client-side state itself, the
        // same way, in the same place. Previously only the persisted
        // copy was cleared; the client-side value survived and looked
        // cleared only by accident, because the very next discussion
        // switch's own outgoing-draft save re-persisted that same stale
        // text right back (see 3a02b68's investigation notes) — a
        // passing invariant by coincidence, not by design. Only clears
        // if the composer still holds exactly what was just submitted:
        // if the user has already started typing something new while
        // this run was in flight (the composer isn't disabled during a
        // run), that's real, unsent content and must not be wiped.
        if (promptTextRef.current === submittedPromptText) {
          setPromptText("");
        }

        // Best-effort: a failure here shouldn't overwrite the run's own
        // result with an unrelated cleanup error.
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
    streamedResponseCreatedAt,
    isStreaming,
    history,
    run,
    lastSwitchDurationMs,
    discussionName,
  };
}
