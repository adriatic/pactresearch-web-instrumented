import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// "Add a discussion to this notebook" is a single, shared UI element
// (not one instance per notebook) meant to target whichever notebook is
// currently selected in the Explorer. It previously tracked its own
// separate, internal notebookId, set only from its own create-notebook
// success -- meaning it always targeted whichever notebook was most
// recently *created* through that exact form, completely ignoring any
// notebook the user actually clicked afterward. With two or more
// notebooks on screen, clicking an earlier one and adding a discussion
// silently created it under the wrong (most-recently-created) notebook
// instead -- confirmed by seeding two notebooks, clicking the first, and
// checking the database directly for where the resulting discussion
// actually landed (it landed on the second, never-clicked one).
//
// Fixed by giving Workspace a real selectedNotebookId, driven by
// Explorer reporting which notebook row was actually clicked (or, for a
// selected discussion, its own parent notebook), and by NotebookCreator
// reading that as a prop instead of tracking its own copy.

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

async function signInFreshUser(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  emailPrefix: string,
) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${emailPrefix}-${suffix}@example.com`;
  const password = "correct horse battery staple 36!";

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }

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

  return { admin, suffix, userId: created.user.id };
}

test.setTimeout(60_000);

test("with two notebooks and neither having a discussion yet, selecting the second and adding a discussion lands it on the second, not the first", async ({
  page,
  context,
}) => {
  const { admin, suffix } = await signInFreshUser(
    page,
    context,
    "e2e-target-two",
  );

  const notebookAName = `Target-A ${suffix}`;
  const notebookBName = `Target-B ${suffix}`;
  const discussionName = `lands on B ${suffix}`;

  await page.goto("/");

  await page.getByLabel("Name:").first().fill(notebookAName);
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByRole("treeitem", { name: notebookAName })).toBeVisible(
    { timeout: 10_000 },
  );

  await page.getByLabel("Name:").first().fill(notebookBName);
  await page.getByRole("button", { name: "Create notebook" }).click();
  const notebookBRow = page.getByRole("treeitem", { name: notebookBName });
  await expect(notebookBRow).toBeVisible({ timeout: 10_000 });

  // Explicitly select B -- creating it doesn't leave A ambiguous here,
  // since B was created most recently and would already be selected;
  // the meaningful case (per the other test below) is selecting an
  // *earlier* notebook. This test's point is B specifically, reached
  // via its own row.
  await notebookBRow.locator("h3").click();

  await page.getByLabel("Name:").last().fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toBeVisible({ timeout: 10_000 });

  const { data: rows, error } = await admin
    .from("discussions")
    .select("notebook_id")
    .eq("name", discussionName);
  expect(error).toBeNull();
  expect(rows).toHaveLength(1);

  const { data: notebookA } = await admin
    .from("notebooks")
    .select("id")
    .eq("name", notebookAName)
    .single();
  const { data: notebookB } = await admin
    .from("notebooks")
    .select("id")
    .eq("name", notebookBName)
    .single();

  expect(rows![0].notebook_id).toBe(notebookB!.id);
  expect(rows![0].notebook_id).not.toBe(notebookA!.id);
});

test("clicking the FIRST of two notebooks after both exist correctly targets the first, not whichever was created last", async ({
  page,
  context,
}) => {
  const { admin, suffix } = await signInFreshUser(
    page,
    context,
    "e2e-target-first",
  );

  const notebookAName = `Target-First-A ${suffix}`;
  const notebookBName = `Target-First-B ${suffix}`;
  const discussionName = `lands on A ${suffix}`;

  await page.goto("/");

  await page.getByLabel("Name:").first().fill(notebookAName);
  await page.getByRole("button", { name: "Create notebook" }).click();
  const notebookARow = page.getByRole("treeitem", { name: notebookAName });
  await expect(notebookARow).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Name:").first().fill(notebookBName);
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByRole("treeitem", { name: notebookBName })).toBeVisible(
    { timeout: 10_000 },
  );

  // The exact repro from the report: both notebooks exist, then click
  // the EARLIER one (B was created after A, so without this fix the
  // panel would still be silently targeting B).
  await notebookARow.locator("h3").click();

  await page.getByLabel("Name:").last().fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toBeVisible({ timeout: 10_000 });

  const { data: rows, error } = await admin
    .from("discussions")
    .select("notebook_id")
    .eq("name", discussionName);
  expect(error).toBeNull();
  expect(rows).toHaveLength(1);

  const { data: notebookA } = await admin
    .from("notebooks")
    .select("id")
    .eq("name", notebookAName)
    .single();
  const { data: notebookB } = await admin
    .from("notebooks")
    .select("id")
    .eq("name", notebookBName)
    .single();

  expect(rows![0].notebook_id).toBe(notebookA!.id);
  expect(rows![0].notebook_id).not.toBe(notebookB!.id);
});

test("with three notebooks, selecting the MIDDLE one targets it correctly -- not an off-by-one or first/last-only assumption", async ({
  page,
  context,
}) => {
  const { admin, suffix } = await signInFreshUser(
    page,
    context,
    "e2e-target-middle",
  );

  const names = [
    `Target-Three-1 ${suffix}`,
    `Target-Three-2 ${suffix}`,
    `Target-Three-3 ${suffix}`,
  ];
  const discussionName = `lands on the middle one ${suffix}`;

  await page.goto("/");

  for (const name of names) {
    await page.getByLabel("Name:").first().fill(name);
    await page.getByRole("button", { name: "Create notebook" }).click();
    await expect(page.getByRole("treeitem", { name })).toBeVisible({
      timeout: 10_000,
    });
  }

  const middleRow = page.getByRole("treeitem", { name: names[1] });
  await middleRow.locator("h3").click();

  await page.getByLabel("Name:").last().fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toBeVisible({ timeout: 10_000 });

  const { data: rows, error } = await admin
    .from("discussions")
    .select("notebook_id")
    .eq("name", discussionName);
  expect(error).toBeNull();
  expect(rows).toHaveLength(1);

  const { data: notebooks } = await admin
    .from("notebooks")
    .select("id, name")
    .in("name", names);
  const middleNotebook = notebooks!.find((n) => n.name === names[1])!;
  const otherNotebookIds = notebooks!
    .filter((n) => n.name !== names[1])
    .map((n) => n.id);

  expect(rows![0].notebook_id).toBe(middleNotebook.id);
  expect(otherNotebookIds).not.toContain(rows![0].notebook_id);
});

test("adding a discussion immediately after creating that notebook (already-passing case) still works, including when another notebook already has discussions", async ({
  page,
  context,
}) => {
  const { admin, suffix, userId } = await signInFreshUser(
    page,
    context,
    "e2e-target-regress",
  );

  const existingNotebookName = `Target-Regress-existing ${suffix}`;
  const existingDiscussionName = `already here ${suffix}`;
  const freshNotebookName = `Target-Regress-fresh ${suffix}`;
  const freshDiscussionName = `added right after creating ${suffix}`;

  const { data: existingNotebook, error: existingNotebookError } = await admin
    .from("notebooks")
    .insert({
      user_id: userId,
      name: existingNotebookName,
      category: "Dev Test",
    })
    .select()
    .single();
  expect(existingNotebookError).toBeNull();
  const { error: existingDiscussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: existingNotebook!.id,
      user_id: existingNotebook!.user_id,
      name: existingDiscussionName,
    });
  expect(existingDiscussionError).toBeNull();

  await page.goto("/");
  await expect(
    page.getByRole("treeitem", { name: existingNotebookName }),
  ).toBeVisible({ timeout: 10_000 });

  // Create a brand new notebook -- per the fix, it becomes selected
  // immediately, with no separate click on its own row required, exactly
  // matching the previously-correct "just created it" flow.
  await page.getByLabel("Name:").first().fill(freshNotebookName);
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(
    page.getByRole("treeitem", { name: freshNotebookName }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("Add a discussion to this notebook"),
  ).toBeVisible();

  await page.getByLabel("Name:").last().fill(freshDiscussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByRole("treeitem", { name: freshDiscussionName }),
  ).toBeVisible({ timeout: 10_000 });

  const { data: rows, error } = await admin
    .from("discussions")
    .select("notebook_id")
    .eq("name", freshDiscussionName);
  expect(error).toBeNull();
  expect(rows).toHaveLength(1);

  const { data: freshNotebook } = await admin
    .from("notebooks")
    .select("id")
    .eq("name", freshNotebookName)
    .single();

  expect(rows![0].notebook_id).toBe(freshNotebook!.id);
  expect(rows![0].notebook_id).not.toBe(existingNotebook!.id);
});
