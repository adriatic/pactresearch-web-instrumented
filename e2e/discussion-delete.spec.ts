import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Covers the per-discussion delete control in the Explorer tree and the
// DELETE /api/discussions route behind it, through the real UI: a real
// browser, a real Next.js dev server, a real request, and the real 409
// the route returns when that discussion itself holds an active
// execution lock.
//
// The 409 case here is deliberately the *discussion's own* lock, which is
// a different check from notebook-delete-lock.spec.ts: that one blocks
// deleting a notebook because some discussion inside it is executing.
// Deleting one discussion is never blocked by a sibling's run, and this
// asserts that distinction rather than assuming it.

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

// Discussions are children of a collapsed notebook row until it's
// expanded — but the app auto-selects the most recent discussion on load
// (page.tsx's findLatestDiscussion) and Explorer auto-expands the
// notebook containing it, so it is often *already* open by the time this
// runs. A one-shot "click if not visible" races the Explorer's own async
// notebook/discussion fetch: checked too early, the tree is still empty,
// the click lands on an already-expanded row, and collapses it.
//
// Retrying until it converges handles both orderings without depending on
// the fetch's timing: each attempt toggles at most once and then
// re-checks, so an accidental collapse is corrected on the next pass.
async function expandNotebook(
  page: import("@playwright/test").Page,
  notebookName: string,
  expectedChildName: string,
) {
  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const childRow = page.getByRole("treeitem", { name: expectedChildName });
  await expect(notebookRow).toBeVisible();

  await expect(async () => {
    if ((await childRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(childRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function seedNotebookWithTwoDiscussions(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  emailPrefix: string,
) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${emailPrefix}-${suffix}@example.com`;
  const password = "correct horse battery staple 22!";
  const notebookName = `E2E discussion-delete notebook ${suffix}`;
  const keptName = `E2E kept discussion ${suffix}`;
  const doomedName = `E2E doomed discussion ${suffix}`;

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

  const { data: discussions, error: discussionError } = await admin
    .from("discussions")
    .insert([
      { notebook_id: notebook!.id, user_id: userId, name: keptName },
      { notebook_id: notebook!.id, user_id: userId, name: doomedName },
    ])
    .select();
  expect(discussionError).toBeNull();

  const kept = discussions!.find((d) => d.name === keptName)!;
  const doomed = discussions!.find((d) => d.name === doomedName)!;

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
  await expandNotebook(page, notebookName, doomedName);

  return { admin, userId, notebookName, keptName, doomedName, kept, doomed };
}

test.setTimeout(60_000);

test("each discussion row has its own delete control, and using it removes exactly that discussion", async ({
  page,
  context,
}) => {
  const { admin, keptName, doomedName, doomed } =
    await seedNotebookWithTwoDiscussions(
      page,
      context,
      "e2e-discussion-delete",
    );

  const doomedRow = page.getByRole("treeitem", { name: doomedName });
  await expect(doomedRow).toHaveCount(1);
  await expect(page.getByRole("treeitem", { name: keptName })).toHaveCount(1);

  page.once("dialog", (dialog) => dialog.accept());

  const deleteResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/discussions") &&
      response.request().method() === "DELETE",
  );

  await doomedRow.getByRole("button", { name: "Delete discussion" }).click();

  const deleteResponse = await deleteResponsePromise;
  expect(deleteResponse.status()).toBe(200);

  // Gone from the tree, and its sibling is untouched.
  await expect(page.getByRole("treeitem", { name: doomedName })).toHaveCount(
    0,
    {
      timeout: 15_000,
    },
  );
  await expect(page.getByRole("treeitem", { name: keptName })).toHaveCount(1);

  // Proven against the database itself, not inferred from the UI alone.
  const { data: rows, error: checkError } = await admin
    .from("discussions")
    .select("id")
    .eq("id", doomed.id);
  expect(checkError).toBeNull();
  expect(rows).toHaveLength(0);
});

test("a discussion holding its own active execution lock can't be deleted, but its sibling still can", async ({
  page,
  context,
}) => {
  const { admin, userId, keptName, doomedName, kept, doomed } =
    await seedNotebookWithTwoDiscussions(page, context, "e2e-discussion-lock");

  // An active (non-stale) lock held by the *doomed* discussion.
  // execution_locks is keyed by user_id, so this is the user's one lock,
  // pointed at that discussion.
  const { error: lockError } = await admin.from("execution_locks").insert({
    user_id: userId,
    discussion_id: doomed.id,
    acquired_at: new Date().toISOString(),
  });
  expect(lockError).toBeNull();

  page.once("dialog", (dialog) => dialog.accept());
  const blockedResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/discussions") &&
      response.request().method() === "DELETE",
  );

  await page
    .getByRole("treeitem", { name: doomedName })
    .getByRole("button", { name: "Delete discussion" })
    .click();

  expect((await blockedResponsePromise).status()).toBe(409);
  await expect(
    page.getByText(
      `"${doomedName}" can't be deleted right now — it's actively executing.`,
    ),
  ).toBeVisible();

  // Still present, in the tree and in the database.
  await expect(page.getByRole("treeitem", { name: doomedName })).toHaveCount(1);
  const { data: stillThere } = await admin
    .from("discussions")
    .select("id")
    .eq("id", doomed.id);
  expect(stillThere).toHaveLength(1);

  // The sibling is not blocked by that lock — deleting a discussion is
  // only ever gated on its own execution, never a neighbour's.
  page.once("dialog", (dialog) => dialog.accept());
  const siblingResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/discussions") &&
      response.request().method() === "DELETE",
  );
  await page
    .getByRole("treeitem", { name: keptName })
    .getByRole("button", { name: "Delete discussion" })
    .click();

  expect((await siblingResponsePromise).status()).toBe(200);
  await expect(page.getByRole("treeitem", { name: keptName })).toHaveCount(0, {
    timeout: 15_000,
  });
  const { data: siblingRows } = await admin
    .from("discussions")
    .select("id")
    .eq("id", kept.id);
  expect(siblingRows).toHaveLength(0);
});
