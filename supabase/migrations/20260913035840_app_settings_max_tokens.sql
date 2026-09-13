-- Global, admin-configurable execution settings. Replaces the hardcoded
-- max_tokens: 1000 in app/api/execute/route.ts (the same value that
-- caused the truncated long responses found in the earlier timing
-- investigation) with a single trusted value every run reads at request
-- time -- matching pact-mac's proven approach: one global value
-- (historically set high enough, 40000, that truncation was never
-- actually hit in practice), not per-user/per-request configuration.
--
-- Singleton table: id is pinned to 1 by the check constraint, so there
-- is exactly one row, seeded below as part of this migration -- no
-- insert/delete policy is needed for regular use.
--
-- Read access is broad (any authenticated user, not just admins) since
-- /api/execute reads this on behalf of whichever user is running a
-- prompt. Write access is admin-only, reusing user_roles/is_admin from
-- 20260912173629_user_roles_is_admin.sql.

create table public.app_settings (
  id         integer primary key default 1,
  max_tokens integer not null default 40000,
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);

insert into public.app_settings (id, max_tokens) values (1, 40000);

alter table public.app_settings enable row level security;

create policy "Any authenticated user can read app settings"
  on public.app_settings
  for select
  using (auth.uid() is not null);

create policy "Only admins can update app settings"
  on public.app_settings
  for update
  using (
    exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and is_admin = true
    )
  )
  with check (
    exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and is_admin = true
    )
  );
