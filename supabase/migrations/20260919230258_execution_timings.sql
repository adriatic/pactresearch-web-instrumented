-- Durable, admin-gated timing data for /api/execute (task 13/14). The
-- console.log-only [timing]/[timing-full]/[timing-detail] lines this same
-- change removes are replaced by real OpenTelemetry spans/attributes for
-- live tracing -- but Vercel's own trace retention on the current Hobby
-- plan tops out at 1 hour (Always-on Tracing), nowhere near durable
-- enough for the admin-gated timing report user_roles/is_admin
-- (20260912173629) was already built to support ("Lays the groundwork
-- for an admin-only response-timing report ... built separately"). This
-- is that table.
--
-- NOT YET WRITTEN TO: this migration only creates the table and its
-- policies. The actual INSERT in app/api/execute/route.ts is deliberate,
-- separate follow-up work, added only once this migration has been
-- applied and confirmed -- per task 14's explicit sequencing, this file
-- is drafted for Nik to review and run himself, not run by CC.
--
-- One row per completed /api/execute invocation, written by the same
-- authenticated user whose request it was -- the same session-scoped
-- client already used for that route's responses/discussions writes, not
-- a service-role write -- so the ordinary "Users manage their own" RLS
-- insert policy applies. Reads are broadened to admins in addition to
-- the owning user: the entire point of this table is a report an admin
-- can read across every user's runs, not just their own.
--
-- discussion_id is ON DELETE SET NULL, unlike every other content table
-- in this schema (which CASCADE) -- deleting a discussion should not
-- silently erase its own timing history out of what's meant to be a
-- durable report.

create table public.execution_timings (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  discussion_id             uuid references public.discussions(id) on delete set null,
  resolved_model            text,
  max_tokens                integer,
  auth_ms                   integer,
  lock_acquire_ms           integer,
  settings_read_ms          integer,
  anthropic_connect_ms      integer,
  message_start_insert_ms   integer,
  time_to_first_token_ms    integer,
  generation_ms             integer,
  throttled_write_count     integer,
  throttled_write_total_ms  integer,
  final_write_ms            integer,
  lock_release_ms           integer,
  total_ms                  integer,
  created_at                timestamptz not null default now()
);

create index execution_timings_user_id_idx on public.execution_timings (user_id);
create index execution_timings_discussion_id_idx on public.execution_timings (discussion_id);
create index execution_timings_created_at_idx on public.execution_timings (created_at);

alter table public.execution_timings enable row level security;

-- Written by /api/execute on behalf of the caller -- same shape as the
-- "Users manage their own X" policies on notebooks/discussions/responses,
-- narrowed to insert+select only. No update/delete policy for regular
-- users: this is append-only diagnostic data, same reasoning as
-- user_roles having no self-service write policy at all.
create policy "Users can insert their own execution timings"
  on public.execution_timings
  for insert
  with check (user_id = auth.uid());

create policy "Users can read their own execution timings"
  on public.execution_timings
  for select
  using (user_id = auth.uid());

-- Postgres RLS OR's multiple permissive policies for the same command
-- together, so this and the owner-read policy above compose correctly:
-- an admin matches this one, everyone else falls through to the
-- owner-only policy. Reuses the exact user_roles/is_admin check already
-- established in 20260913035840_app_settings_max_tokens.sql.
create policy "Admins can read all execution timings"
  on public.execution_timings
  for select
  using (
    exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and is_admin = true
    )
  );
