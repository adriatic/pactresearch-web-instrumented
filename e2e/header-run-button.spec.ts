import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// The Run action moved out of the composer and into the global header,
// alongside New Notebook / Import / Settings / Account / Model. What
// matters and is pinned here: it acts on the *currently selected*
// discussion using that discussion's own composer text, it is disabled
// when no discussion is selected (matching the other header buttons'
// applicability gating), and the composer itself no longer carries a Run
// control of its own.
//
// /api/execute is mocked at the browser network layer for the same reason
// as execute-result-no-raw-json.spec.ts: no ANTHROPIC_API_KEY is
// configured locally, and the client code path exercised is identical
// either way.

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

test("Run lives in the header, is the page's only Run control, and runs the selected discussion's composer text", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-header-run-${suffix}@example.com`;
  const password = "correct horse battery staple 23!";
  const notebookName = `E2E header-run notebook ${suffix}`;
  const discussionName = `E2E header-run discussion ${suffix}`;

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

  const { error: discussionError } = await admin
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

  const responseText = "# Ran from the header\n\nIt **worked**.";
  let executedPromptText: string | null = null;
  await page.route("**/api/execute", async (route) => {
    const body = route.request().postDataJSON() as { promptText?: string };
    executedPromptText = body.promptText ?? null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: responseText,
        resolved_model: "claude-sonnet-4-6-mock",
      }),
    });
  });

  await page.goto("/");

  // The Run button is in the header, not the composer. Scoped to the
  // <header> specifically so this can't accidentally pass on a stray
  // Run control living somewhere else on the page.
  const headerRun = page.locator("header").getByRole("button", { name: "Run" });
  await expect(headerRun).toBeVisible();
  await expect(page.getByRole("button", { name: "Run" })).toHaveCount(1);

  // This account has a discussion, and the app auto-selects the most
  // recent one on load (page.tsx's findLatestDiscussion) — so Run is
  // applicable immediately. The no-selection case is its own test below,
  // which needs an account with no discussions at all to reach.
  //
  // Expanding is retried rather than done once: the Explorer's
  // notebook/discussion fetch is async and the auto-expand follows it, so
  // a single "click if not visible" can land on an already-expanded row
  // and collapse it. Each pass toggles at most once, then re-checks.
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
  await expect(headerRun).toBeEnabled();

  // It runs the selected discussion's own composer text.
  const promptText = `header run prompt ${suffix}`;
  await page.getByLabel("Prompt").fill(promptText);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    headerRun.click(),
  ]);
  await expect(headerRun).toBeEnabled();

  expect(executedPromptText).toBe(promptText);
  await expect(
    page.getByRole("heading", { name: "Ran from the header" }),
  ).toBeVisible();
});

test("the header Run button is disabled when no discussion is selected", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-header-run-none-${suffix}@example.com`;
  const password = "correct horse battery staple 25!";
  const notebookName = `E2E header-run empty notebook ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }

  // A notebook with no discussions at all: findLatestDiscussion has
  // nothing to auto-select, which is the only way to reach the
  // no-selection state on load.
  const { error: notebookError } = await admin
    .from("notebooks")
    .insert({
      user_id: created.user.id,
      name: notebookName,
      category: "Dev Test",
    })
    .select()
    .single();
  expect(notebookError).toBeNull();

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

  await expect(
    page.getByText("No discussion selected — create or pick one above."),
  ).toBeVisible();
  await expect(
    page.locator("header").getByRole("button", { name: "Run" }),
  ).toBeDisabled();
});
