import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the composer's draft is genuinely persisted per discussion, not
// a special-cased in-memory value (superseding 4d64d02, which cleared
// promptText on switch instead of persisting it): switching away saves the
// outgoing discussion's draft, switching to any discussion loads its own
// persisted draft, and reloading the page entirely proves this is real
// database persistence, not a session-only illusion. Also confirms the
// original misattribution risk still doesn't happen — a discussion's
// composer never shows another discussion's draft.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  const output = execFileSync("npx", ["supabase", "status", "-o", "json"], {
    encoding: "utf-8",
  });
  return JSON.parse(output) as LocalSupabaseStatus;
}

test.setTimeout(60_000);

test("a discussion's draft survives switching away and back, and reloading the page, without leaking into another discussion", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-draft-persist-${suffix}@example.com`;
  const password = "correct horse battery staple 8!";
  const notebookName = `E2E draft-persist notebook ${suffix}`;
  const discussionAName = `E2E draft-persist discussion A ${suffix}`;
  const discussionBName = `E2E draft-persist discussion B ${suffix}`;
  const draftText = `This draft should survive switching away and reloading ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { data: notebook, error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { error: discussionAError } = await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionAName,
  });
  expect(discussionAError).toBeNull();

  const { error: discussionBError } = await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionBName,
  });
  expect(discussionBError).toBeNull();

  // Real session, real cookies — same pattern as
  // e2e/notebook-delete-lock.spec.ts: signed in server-side via a cookie
  // jar (no real magic-link email involved), then injected into the
  // actual browser context.
  const capturedCookies: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => capturedCookies,
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => {
          const existing = capturedCookies.find((c) => c.name === name);
          if (existing) {
            existing.value = value;
          } else {
            capturedCookies.push({ name, value });
          }
        });
      },
    },
  });
  const { error: signInError } = await jarClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;

  await context.addCookies(
    capturedCookies.map(({ name, value }) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "Lax" as const,
    })),
  );

  await page.goto("/");

  const discussionALink = page.getByRole("treeitem", {
    name: discussionAName,
  });
  const discussionBLink = page.getByRole("treeitem", {
    name: discussionBName,
  });
  const composer = page.locator("textarea");

  await expect(discussionALink).toBeVisible();
  await expect(discussionBLink).toBeVisible();

  // Establish a known active discussion regardless of which one
  // findLatestDiscussion picked on initial load.
  await discussionALink.click();
  await expect(page.getByText(`Discussion: `)).toBeVisible();
  await expect(composer).toHaveValue("");

  await composer.fill(draftText);
  await expect(composer).toHaveValue(draftText);

  // Switch away — this must save A's draft (awaited by the app itself
  // before B's data loads) before B's composer is ever shown.
  await discussionBLink.click();

  // B's composer must start empty — no leakage of A's draft into a
  // different discussion, the original misattribution risk this whole
  // feature exists to avoid.
  await expect(composer).toHaveValue("");

  // Switch back — the draft must be there, restored from the database,
  // not lost the way the superseded 4d64d02 approach lost it.
  await discussionALink.click();
  await expect(composer).toHaveValue(draftText);

  // Prove this is real persistence, not a session-only illusion: reload
  // the page entirely (fresh React state, fresh network requests — the
  // context's cookies persist across the reload on their own, no
  // re-authentication needed) and navigate back to discussion A.
  await page.reload();
  await expect(discussionALink).toBeVisible();
  await discussionALink.click();
  await expect(composer).toHaveValue(draftText);
});

// Companion to the draft-persistence test above: an already-run
// discussion with no separately-saved draft falls back to its own most
// recent cell's prompt, rather than showing an empty composer. This is
// the same saveThenLoad fallback that fixes the export/delete/import
// round trip (e2e/notebook-export-import.spec.ts) — pinned here
// separately because it's real, standalone behavior for ordinary
// discussion switching too, not just something import happens to expose.
test("an already-run discussion with no saved draft shows its last-run prompt, and an explicit unsent draft still wins", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-last-prompt-fallback-${suffix}@example.com`;
  const password = "correct horse battery staple 28!";
  const notebookName = `E2E last-prompt-fallback notebook ${suffix}`;
  const ranDiscussionName = `E2E last-prompt-fallback ran ${suffix}`;
  const draftDiscussionName = `E2E last-prompt-fallback draft ${suffix}`;
  const lastRunPrompt = `the last prompt actually run ${suffix}`;
  const unsentDraft = `an unsent draft, never run ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { data: notebook, error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { data: discussions, error: discussionsError } = await admin
    .from("discussions")
    .insert([
      { notebook_id: notebook!.id, user_id: userId, name: ranDiscussionName },
      {
        notebook_id: notebook!.id,
        user_id: userId,
        name: draftDiscussionName,
        // A genuine unsent draft AND a prior run both present -- the
        // draft must win, since it may differ from what was last run.
        draft_prompt_text: unsentDraft,
      },
    ])
    .select();
  expect(discussionsError).toBeNull();
  const ranDiscussion = discussions!.find((d) => d.name === ranDiscussionName)!;
  const draftDiscussion = discussions!.find(
    (d) => d.name === draftDiscussionName,
  )!;

  // A real prior run, with the persisted draft already cleared -- exactly
  // what run()'s own post-success cleanup leaves behind, not a
  // hand-picked shortcut.
  const { error: ranCellError } = await admin.from("responses").insert({
    discussion_id: ranDiscussion.id,
    user_id: userId,
    prompt_text: lastRunPrompt,
    response: "the response",
    model: "claude-sonnet-4-6",
    resolved_model: "claude-sonnet-4-6-20260101",
    cell_type: "assistant",
  });
  expect(ranCellError).toBeNull();

  const { error: draftCellError } = await admin.from("responses").insert({
    discussion_id: draftDiscussion.id,
    user_id: userId,
    prompt_text: "an earlier, already-run prompt",
    response: "an earlier response",
    model: "claude-sonnet-4-6",
    resolved_model: "claude-sonnet-4-6-20260101",
    cell_type: "assistant",
  });
  expect(draftCellError).toBeNull();

  const capturedCookies: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => capturedCookies,
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => {
          const existing = capturedCookies.find((c) => c.name === name);
          if (existing) {
            existing.value = value;
          } else {
            capturedCookies.push({ name, value });
          }
        });
      },
    },
  });
  const { error: signInError } = await jarClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;

  await context.addCookies(
    capturedCookies.map(({ name, value }) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "Lax" as const,
    })),
  );

  await page.goto("/");

  const ranLink = page.getByRole("treeitem", { name: ranDiscussionName });
  const draftLink = page.getByRole("treeitem", { name: draftDiscussionName });
  const composer = page.locator("textarea");

  await expect(ranLink).toBeVisible();
  await expect(draftLink).toBeVisible();

  // No unsent draft -- falls back to the last cell actually run.
  await ranLink.click();
  await expect(page.getByText(lastRunPrompt).first()).toBeVisible();
  await expect(composer).toHaveValue(lastRunPrompt);

  // An unsent draft exists -- it wins over that discussion's own history,
  // even though that discussion also has a prior run.
  await draftLink.click();
  await expect(composer).toHaveValue(unsentDraft);

  // Switching back still shows the fallback, not leftover state from the
  // discussion just visited.
  await ranLink.click();
  await expect(composer).toHaveValue(lastRunPrompt);
});
