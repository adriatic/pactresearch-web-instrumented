import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Persistence audit finding D: Explorer.tsx used to fall back to a
// notebook's or discussion's own raw uuid as the tree row's display name
// whenever `name` was empty -- reachable via a .pact import with an
// empty-string name. Import now rejects that at validation (see
// lib/pactExport.ts's requireNonEmptyString and the notebooks-import-
// export integration tests), so this display fallback is no longer
// reachable through the app's own UI. It stays as a display-layer guard
// regardless of how an empty name might reach the database -- seeded
// directly here, bypassing the app entirely, since that's the only way
// left to exercise it: the database column itself is only `not null`,
// not "non-empty", so nothing at the schema level prevents this state.

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

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test.setTimeout(60_000);

test("a notebook or discussion with an empty name shows a placeholder in the Explorer tree, never its raw uuid", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-empty-name-fallback-${suffix}@example.com`;
  const password = "correct horse battery staple 31!";

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  // An empty-name notebook, bypassing the app's own creation path
  // entirely (which requires a non-empty name both client- and
  // server-side) -- this is what a corrupted row, or an empty name that
  // reaches the database through some future, different path, would look
  // like.
  const { error: emptyNotebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: "", category: "Dev Test" });
  expect(emptyNotebookError).toBeNull();

  // A named notebook holding an empty-name discussion, so both fallbacks
  // are exercised in the same test.
  const namedNotebookName = `E2E empty-name-fallback named notebook ${suffix}`;
  const { data: namedNotebook, error: namedNotebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: namedNotebookName, category: "Dev Test" })
    .select()
    .single();
  expect(namedNotebookError).toBeNull();

  const { error: emptyDiscussionError } = await admin
    .from("discussions")
    .insert({ notebook_id: namedNotebook!.id, user_id: userId, name: "" });
  expect(emptyDiscussionError).toBeNull();

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

  // The empty-name notebook shows a placeholder, not its raw uuid.
  await expect(
    page.getByRole("treeitem", { name: "Untitled notebook" }),
  ).toBeVisible();

  // The named notebook expands to reveal its empty-name discussion,
  // which also shows a placeholder, not its raw uuid.
  const namedNotebookRow = page.getByRole("treeitem", {
    name: namedNotebookName,
  });
  const untitledDiscussionRow = page.getByRole("treeitem", {
    name: "Untitled discussion",
  });
  await expect(namedNotebookRow).toBeVisible();
  await expect(async () => {
    if ((await untitledDiscussionRow.count()) === 0) {
      await namedNotebookRow.locator("h3").click();
    }
    await expect(untitledDiscussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // Nowhere in the Explorer sidebar does a raw uuid ever appear as
  // visible text.
  const sidebar = page.locator("section", { has: page.getByText("Explorer") });
  await expect(sidebar.getByText(UUID_PATTERN)).toHaveCount(0);
});
