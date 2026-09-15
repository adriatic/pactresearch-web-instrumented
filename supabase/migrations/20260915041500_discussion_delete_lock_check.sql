-- Per-discussion counterpart to notebook_active_execution_lock_discussion_id
-- (20260908224401). DELETE /api/discussions needs the same protection the
-- notebook-delete route already has, for the same reason: deleting a
-- discussion while its own Anthropic call is still in flight leaves that
-- call writing responses rows against a discussion that no longer exists,
-- and its output is silently discarded when it resolves.
--
-- Deliberately a separate function rather than reusing the notebook one:
-- that check asks "does any discussion *in this notebook* hold an active
-- lock" (and returns which), while this asks "does *this* discussion hold
-- one" -- different questions, and collapsing them into one function
-- would mean passing a null notebook id or a mode flag to pick between
-- them. Both share execution_lock_stale_after() as the single source of
-- truth for staleness, which is the part that actually must not drift.
--
-- execution_locks is keyed by user_id (one lock per user, not per
-- discussion), so this can only ever match the caller's own lock row.
-- SECURITY INVOKER + RLS on execution_locks ("Users manage their own
-- execution lock") already restricts this to the caller's own data, the
-- same way every other route in this codebase relies on RLS rather than a
-- separate ownership check.
create or replace function public.discussion_has_active_execution_lock(
  p_discussion_id uuid
) returns boolean
language sql
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.execution_locks el
    where el.discussion_id = p_discussion_id
      and el.acquired_at >= now() - public.execution_lock_stale_after()
  );
$$;
