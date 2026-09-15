import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the real UI round trip: export a notebook to a real downloaded
// .pact file, feed that exact file back into the Import flow, and confirm
// a second, independent, content-identical notebook appears in the tree
// -- the actual point of this feature (repeatable test fixtures).

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

test("exporting a notebook and importing it back creates a second, content-identical notebook in the tree", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-export-import-${suffix}@example.com`;
  const password = "correct horse battery staple 12!";
  const notebookName = `E2E export-import notebook ${suffix}`;
  const discussionName = `E2E export-import discussion ${suffix}`;

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
    .insert({
      user_id: userId,
      name: notebookName,
      system_prompt: "Be concise.",
      category: "Dev Test",
    })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { data: discussion, error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
      total_time_ms: 1234,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();

  const { error: cellError } = await admin.from("responses").insert({
    discussion_id: discussion!.id,
    user_id: userId,
    prompt_text: "What is the export/import round trip for?",
    response: "Repeatable test fixtures.",
    model: "claude-sonnet-4-6",
    resolved_model: "claude-sonnet-4-6-20260101",
    cell_type: "assistant",
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

  // Exactly one notebook row exists before the import.
  const notebookRows = page.getByRole("treeitem", { name: notebookName });
  await expect(notebookRows).toHaveCount(1);

  // Real download, via the real Export button -- not a fabricated file.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    notebookRows.getByRole("button", { name: "Export" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pact$/);
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();

  // The hidden file input behind the header's "Import" button -- setting
  // files directly on it is the standard Playwright pattern for file
  // inputs (works even when the input itself is display:none).
  await page
    .locator('input[type="file"][accept=".pact"]')
    .setInputFiles(downloadedPath!);

  // The import created a second, independent notebook -- the tree now
  // shows two rows where it showed one. Its name is the original plus a
  // " 1" suffix, since importing back into the same account collides
  // with the notebook it was exported from (getByRole's name option is a
  // substring match, so both rows still match notebookName). A longer
  // timeout than this suite's usual default: unlike a typical
  // single-fetch UI action, this round trip is a file read followed by
  // three sequential inserts (notebook, discussions, cells) and then the
  // Explorer's own refetch -- genuinely more work, so it's more sensitive
  // to system load than most assertions in this suite.
  await expect(notebookRows).toHaveCount(2, { timeout: 15_000 });
  await expect(
    page.getByRole("treeitem", { name: `${notebookName} 1` }),
  ).toHaveCount(1);

  // Expanding the newly-imported one shows its discussion, carried over
  // correctly, not just an empty shell. GET /api/notebooks orders newest
  // first, so the just-imported notebook is the first of the two rows,
  // not the last. Clicking the heading specifically (not the row's
  // bounding-box center) avoids any risk of landing on the Export/Delete
  // buttons that share the row.
  await notebookRows.first().locator("h3").click();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toHaveCount(2, { timeout: 15_000 });
});

// Item 7's auto-rename: importing the same .pact file repeatedly must
// produce distinctly-named notebooks rather than a pile of
// identically-named ones. This is deliberately placeholder behavior (a
// future task replaces it with an interactive name prompt), so what's
// pinned here is only the observable outcome -- distinct names, in the
// documented "<name> 1", "<name> 2" shape -- not the mechanism.
test("importing the same .pact file twice auto-renames each collision instead of duplicating the name", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-import-rename-${suffix}@example.com`;
  const password = "correct horse battery staple 21!";
  const notebookName = `E2E import-rename notebook ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
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

  const originalRow = page.getByRole("treeitem", { name: notebookName });
  await expect(originalRow).toHaveCount(1);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    originalRow.getByRole("button", { name: "Export" }).click(),
  ]);
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();

  const fileInput = page.locator('input[type="file"][accept=".pact"]');

  // First import collides with the original -> "<name> 1".
  await fileInput.setInputFiles(downloadedPath!);
  await expect(
    page.getByRole("treeitem", { name: `${notebookName} 1` }),
  ).toHaveCount(1, { timeout: 15_000 });

  // Second import of the exact same file collides with both -> "<name> 2",
  // not a second "<name> 1" and not another bare "<name>".
  await fileInput.setInputFiles(downloadedPath!);
  await expect(
    page.getByRole("treeitem", { name: `${notebookName} 2` }),
  ).toHaveCount(1, { timeout: 15_000 });

  // Three rows total, each a distinct name -- no duplicates anywhere.
  const allRows = page.getByRole("treeitem", { name: notebookName });
  await expect(allRows).toHaveCount(3);
  const names = await allRows.locator("h3").allInnerTexts();
  expect(new Set(names).size).toBe(3);
  expect([...names].sort()).toEqual(
    [notebookName, `${notebookName} 1`, `${notebookName} 2`].sort(),
  );
});
