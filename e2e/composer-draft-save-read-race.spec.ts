import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Investigated a manual report: typed a prompt into a discussion's
// composer, switched to a different discussion without running it, then
// switched back -- the draft did not appear to be restored.
//
// Confirmed via direct DB inspection that draft_prompt_text *was*
// correctly written by the switch-away save in the simple case (type,
// switch away, wait, switch back) -- so this is not a case of the save
// never firing. The real, reproducible mechanism only shows up under
// production-realistic network latency (local dev's near-zero round
// trips otherwise make the window too narrow to land in with a handful
// of sequential actions): switch away from a discussion (firing its
// outgoing-draft-save PATCH), then switch straight back before that
// PATCH has actually landed. The switch-back has nothing new of its own
// to save (the discussion just left never had its own load validated),
// so it always used to proceed straight to reloading the discussion
// being returned to -- racing ahead of the still-in-flight save and
// reading the *pre-save* draft_prompt_text. The save then succeeds a
// moment later regardless, but nothing ever re-synced the client's
// already-rendered (empty) composer to reflect it -- a display bug, not
// a persistence bug, but one indistinguishable from data loss to the
// person looking at an empty composer.
//
// Fixed by having a switch that skips its own save (nothing new to
// write) wait for any earlier switch's still-in-flight save first,
// before reading anything -- see useDiscussionExecution's
// pendingOutgoingSaveRef.

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

test("switching away then immediately back shows the just-typed draft, even before the outgoing save has actually landed", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-draft-save-read-race-${suffix}@example.com`;
  const password = "correct horse battery staple 40!";
  const notebookName = `E2E draft-race notebook ${suffix}`;
  const discussionAName = `Disc-A ${suffix}`;
  const discussionBName = `Disc-B ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { data: notebook, error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { data: discussions, error: discussionsError } = await admin
    .from("discussions")
    .insert([
      { notebook_id: notebook!.id, user_id: userId, name: discussionAName },
      { notebook_id: notebook!.id, user_id: userId, name: discussionBName },
    ])
    .select();
  expect(discussionsError).toBeNull();
  const discussionA = discussions!.find((d) => d.name === discussionAName)!;

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

  // Asymmetric artificial latency, deliberately forcing the race rather
  // than leaving it to chance timing: the outgoing-save PATCH is made
  // much slower than the incoming-load GET, so if the load can race
  // ahead of the save and read stale data, this guarantees it happens.
  await page.route("**/api/discussions**", async (route) => {
    const delay = route.request().method() === "PATCH" ? 2_000 : 50;
    await new Promise((r) => setTimeout(r, delay));
    await route.continue();
  });
  await page.route("**/api/responses**", async (route) => {
    await new Promise((r) => setTimeout(r, 50));
    await route.continue();
  });

  await page.goto("/");
  await page.getByText(/Switched in/).waitFor({ timeout: 20_000 });

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const discussionARow = page.getByRole("treeitem", { name: discussionAName });
  const discussionBRow = page.getByRole("treeitem", { name: discussionBName });
  await expect(notebookRow).toBeVisible();
  await expect(async () => {
    if ((await discussionARow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionARow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await discussionARow.click();
  await page.waitForTimeout(1_000);
  const draftText = `draft-race draft ${suffix}`;
  await page.getByLabel("Prompt").fill(draftText);

  // Switch to B, then immediately back to A -- no wait at all -- while
  // A's own outgoing-save PATCH is guaranteed still in flight (2s delay,
  // vs. 50ms GETs).
  await discussionBRow.click();
  await discussionARow.click();

  // Checked deliberately early -- after A's own (fast) GETs would have
  // resolved, but well before its (slow) outgoing-save PATCH has. Before
  // the fix, this read stale (pre-save) data and showed an empty
  // composer permanently, even though the save went on to succeed.
  await expect(page.getByLabel("Prompt")).toHaveValue(draftText, {
    timeout: 5_000,
  });

  // And it's still correct well after everything, including the slow
  // PATCH, has settled -- not a flicker that only happened to pass at
  // the exact moment checked above.
  await page.waitForTimeout(2_500);
  await expect(page.getByLabel("Prompt")).toHaveValue(draftText);

  const { data: discussionAAfter, error: checkError } = await admin
    .from("discussions")
    .select("draft_prompt_text")
    .eq("id", discussionA.id)
    .single();
  expect(checkError).toBeNull();
  expect(discussionAAfter!.draft_prompt_text).toBe(draftText);
});
