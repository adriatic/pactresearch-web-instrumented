import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Root-caused during a persistence audit (following up on the 3a02b68
// export/import composer investigation): switching away from a
// discussion before its OWN saveThenLoad ever finishes loading can
// corrupt the NEXT discussion's persisted draft with completely
// unrelated, leftover content.
//
// Mechanism: the outgoing-draft save always persists whatever is
// currently in promptTextRef.current under the discussion being switched
// away from. If that discussion's own load was interrupted before it
// ever got to call setPromptText for its own data (a second, rapid
// switch landing before the first one's fetches resolve), promptText
// still holds the *previous* discussion's leftover content -- and that
// gets silently written as the interrupted discussion's own draft,
// overwriting whatever its real value should have been (typically null).
// Fixed by promptTextOwnerRef: the outgoing-save only fires if promptText
// was actually produced by that discussion's own completed load.
//
// Reproduced locally by adding artificial network latency (the local
// stack's near-zero round trips otherwise close the race window too
// fast for a handful of sequential .click() calls to land inside it) --
// this is deliberately the same shape of latency a real deployed
// environment has natively, not an artificial-only scenario.

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

test.setTimeout(90_000);

test("switching through a discussion before its own load completes doesn't corrupt its persisted draft with the previous discussion's content", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-switch-race-${suffix}@example.com`;
  const password = "correct horse battery staple 29!";
  const notebookName = `E2E switch-race notebook ${suffix}`;
  const discussionAName = `Disc-A ${suffix}`;
  const discussionBName = `Disc-B ${suffix}`;
  const discussionCName = `Disc-C ${suffix}`;

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
      { notebook_id: notebook!.id, user_id: userId, name: discussionCName },
    ])
    .select();
  expect(discussionsError).toBeNull();
  const discussionA = discussions!.find((d) => d.name === discussionAName)!;
  const discussionB = discussions!.find((d) => d.name === discussionBName)!;
  const discussionC = discussions!.find((d) => d.name === discussionCName)!;

  // B and C each have real history and deliberately no draft -- the
  // correct state for the outgoing-save to never touch.
  const bLastPrompt = `b's real last prompt ${suffix}`;
  const cLastPrompt = `c's real last prompt ${suffix}`;
  const { error: cellsError } = await admin.from("responses").insert([
    {
      discussion_id: discussionB.id,
      user_id: userId,
      prompt_text: bLastPrompt,
      response: "b response",
      model: "claude-sonnet-4-6",
      resolved_model: "claude-sonnet-4-6-20260101",
      cell_type: "assistant",
    },
    {
      discussion_id: discussionC.id,
      user_id: userId,
      prompt_text: cLastPrompt,
      response: "c response",
      model: "claude-sonnet-4-6",
      resolved_model: "claude-sonnet-4-6-20260101",
      cell_type: "assistant",
    },
  ]);
  expect(cellsError).toBeNull();

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

  // Artificial latency on the exact two request types saveThenLoad
  // makes -- local dev's near-zero round trips otherwise close the race
  // window faster than sequential .click() calls can land inside it.
  await page.route("**/api/discussions**", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await page.route("**/api/responses**", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });

  await page.goto("/");
  await page.getByText(/Switched in/).waitFor({ timeout: 20_000 });

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const aRow = page.getByRole("treeitem", { name: discussionAName });
  const bRow = page.getByRole("treeitem", { name: discussionBName });
  const cRow = page.getByRole("treeitem", { name: discussionCName });

  await expect(notebookRow).toBeVisible();
  await expect(async () => {
    if ((await aRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(aRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // A has no history -- give it a genuine unsent draft, fully loaded
  // before we ever move away from it.
  await aRow.click();
  await page.waitForTimeout(600);
  const draftForA = `a's real unsent draft ${suffix}`;
  await page.getByLabel("Prompt").fill(draftForA);

  // The race: switch to B, then immediately to C, with no wait -- B's
  // own saveThenLoad never gets a chance to load B's real data (gated
  // behind the delayed outgoing-save PATCH for A) before we leave B.
  await bRow.click();
  await cRow.click();

  // Let everything settle before checking.
  await page.waitForTimeout(1_500);

  // The actual bug: B's draft must still be null -- A's leftover content
  // must never have been persisted under B's id.
  const { data: bAfter, error: bAfterError } = await admin
    .from("discussions")
    .select("draft_prompt_text")
    .eq("id", discussionB.id)
    .single();
  expect(bAfterError).toBeNull();
  expect(bAfter!.draft_prompt_text).toBeNull();

  // A's own real draft must still be intact -- correctly saved on the
  // first, non-interrupted switch away from it.
  const { data: aAfter, error: aAfterError } = await admin
    .from("discussions")
    .select("draft_prompt_text")
    .eq("id", discussionA.id)
    .single();
  expect(aAfterError).toBeNull();
  expect(aAfter!.draft_prompt_text).toBe(draftForA);

  // End to end: visiting B now shows its own last-run prompt (via the
  // 3a02b68 fallback, since its draft is correctly null), not A's draft
  // and not C's.
  await bRow.click();
  await expect(page.getByLabel("Prompt")).toHaveValue(bLastPrompt, {
    timeout: 10_000,
  });
});
