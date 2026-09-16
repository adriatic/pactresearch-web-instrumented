import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Three cosmetic-only display cleanups to DiscussionContent.tsx:
// 1. The "Execute tester" heading is gone -- meaningless placeholder text.
// 2. The "Discussion: {name}" line now also shows when the most recently
//    created response was made, using that response's own real
//    created_at (sourced all the way from the database row itself, not
//    an approximate client-side timestamp -- see /api/execute's
//    response_created_at and useDiscussionExecution's history append).
// 3. The "History" heading is gone -- same reasoning as (1).
//
// Verified across two discussions: one with an existing response (the
// timestamp must show and be correct), one with none yet (no timestamp,
// and nothing crashes on the empty case).

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

test("Execute tester and History headings are gone, and a discussion with a response shows its real timestamp", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-display-cleanup-${suffix}@example.com`;
  const password = "correct horse battery staple 32!";
  const notebookName = `E2E display-cleanup notebook ${suffix}`;
  const discussionWithHistoryName = `E2E display-cleanup with-history ${suffix}`;
  const discussionWithoutHistoryName = `E2E display-cleanup no-history ${suffix}`;

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
      {
        notebook_id: notebook!.id,
        user_id: userId,
        name: discussionWithHistoryName,
      },
      {
        notebook_id: notebook!.id,
        user_id: userId,
        name: discussionWithoutHistoryName,
      },
    ])
    .select();
  expect(discussionsError).toBeNull();
  const discussionWithHistory = discussions!.find(
    (d) => d.name === discussionWithHistoryName,
  )!;

  // A known, fixed timestamp -- not "now" -- so the test proves the real
  // created_at is what's displayed, not merely today's date coinciding
  // with a fabricated one.
  const knownCreatedAt = new Date("2026-01-15T10:30:00.000Z");
  const { error: cellError } = await admin.from("responses").insert({
    discussion_id: discussionWithHistory.id,
    user_id: userId,
    prompt_text: "a prompt",
    response: "a response",
    model: "claude-sonnet-4-6",
    resolved_model: "claude-sonnet-4-6-20260101",
    cell_type: "assistant",
    created_at: knownCreatedAt.toISOString(),
  });
  expect(cellError).toBeNull();

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

  // 1 & 3: neither placeholder heading exists anywhere on the page.
  await expect(page.getByText("Execute tester")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "History" })).toHaveCount(0);

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const withHistoryRow = page.getByRole("treeitem", {
    name: discussionWithHistoryName,
  });
  const withoutHistoryRow = page.getByRole("treeitem", {
    name: discussionWithoutHistoryName,
  });
  await expect(notebookRow).toBeVisible();
  await expect(async () => {
    if ((await withHistoryRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(withHistoryRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // 2: the discussion with a response shows its real, exact timestamp,
  // on the same line as "Discussion: {name}".
  await withHistoryRow.click();
  const expectedTimestamp = knownCreatedAt.toLocaleString();
  const discussionLine = page.getByText(
    `Discussion: ${discussionWithHistoryName} — Response: ${expectedTimestamp}`,
  );
  await expect(discussionLine).toBeVisible();

  // The discussion with no response yet shows no timestamp at all --
  // nothing crashes on the empty case, and nothing fabricates one.
  await withoutHistoryRow.click();
  await expect(
    page.getByText(`Discussion: ${discussionWithoutHistoryName}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/Response: /)).toHaveCount(0);
});
