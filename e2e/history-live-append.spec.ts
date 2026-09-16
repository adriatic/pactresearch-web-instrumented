import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Persistence audit finding A: run() never appended to the in-memory
// history array -- a newly-completed prompt+response was only visible
// via the separate "Live response" section (itself overwritten by the
// *next* run) until some later, unrelated discussion switch happened to
// trigger saveThenLoad's own fetch. Running a second prompt in the same
// discussion, without ever switching away, used to make the first run's
// content disappear from History entirely for the rest of that session.
//
// /api/execute is mocked (no ANTHROPIC_API_KEY locally), but each mock
// genuinely inserts its own responses row and returns response_row_id
// pointing at it -- matching exactly what the real route does -- so this
// exercises the real append path, not a client-only illusion.

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

test("running two prompts in the same discussion without switching away shows both in History", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-history-append-${suffix}@example.com`;
  const password = "correct horse battery staple 30!";
  const notebookName = `E2E history-append notebook ${suffix}`;
  const discussionName = `E2E history-append discussion ${suffix}`;

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

  const { data: discussion, error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();

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

  const firstPrompt = `first prompt ${suffix}`;
  const firstResponse = `first response ${suffix}`;
  const secondPrompt = `second prompt ${suffix}`;
  const secondResponse = `second response ${suffix}`;

  await page.route("**/api/execute", async (route) => {
    const body = route.request().postDataJSON() as { promptText: string };
    const isFirst = body.promptText === firstPrompt;
    const { data: inserted, error } = await admin
      .from("responses")
      .insert({
        discussion_id: discussion!.id,
        user_id: userId,
        prompt_text: body.promptText,
        response: isFirst ? firstResponse : secondResponse,
        model: "claude-sonnet-4-6",
        resolved_model: "claude-sonnet-4-6-mock",
        cell_type: "assistant",
      })
      .select("id, created_at")
      .single();
    if (error) throw error;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: isFirst ? firstResponse : secondResponse,
        resolved_model: "claude-sonnet-4-6-mock",
        response_row_id: inserted!.id,
        response_created_at: inserted!.created_at,
      }),
    });
  });

  await page.goto("/");
  await page.getByText(/Switched in/).waitFor({ timeout: 15_000 });

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(notebookRow).toBeVisible();
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussionRow.click();

  const prompt = page.getByLabel("Prompt");
  const runButton = page.locator("header").getByRole("button", { name: "Run" });

  // First run.
  await prompt.fill(firstPrompt);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    runButton.click(),
  ]);
  await expect(runButton).toBeDisabled();

  // Second run, in the same discussion, with no switch away in between --
  // exactly the scenario that used to make the first run vanish from
  // History for the rest of the session.
  await prompt.fill(secondPrompt);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    runButton.click(),
  ]);
  await expect(runButton).toBeDisabled();

  // Both must be visible in History -- not just the second run's content
  // via the separate "Live response"/"Response" section. The first run's
  // content only appears via History (that section only ever shows the
  // *most recent* run, so it's been overwritten by the second run by
  // this point); the second run's content legitimately appears twice --
  // once in History (this fix), once still in the "Response" section
  // (pre-existing, unrelated to this fix) -- so its assertion allows
  // either.
  const historySection = page.locator("main");
  await expect(historySection.getByText(firstPrompt)).toBeVisible();
  await expect(historySection.getByText(firstResponse)).toBeVisible();
  await expect(historySection.getByText(secondPrompt)).toBeVisible();
  await expect(historySection.getByText(secondResponse).first()).toBeVisible();

  // Confirmed without ever switching away or reloading -- exactly the
  // gap this fix closes. A reload afterward should still show both,
  // proving this isn't a client-only illusion diverging from the DB.
  await page.reload();
  await page.getByText(/Switched in/).waitFor({ timeout: 15_000 });
  await expect(page.locator("main").getByText(firstPrompt)).toBeVisible();
  await expect(page.locator("main").getByText(secondPrompt)).toBeVisible();
});
