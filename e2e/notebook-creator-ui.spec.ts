import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Two manual-testing bugs fixed together: (1) creating a notebook or
// discussion used to dump the raw JSON API response into the UI instead of
// a human-readable confirmation; (2) every <button> in the app rendered as
// plain inline text, indistinguishable from static content, since none of
// them had any visual treatment at all.

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
  const password = "correct horse battery staple 14!";

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
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

  await page.goto("/");
  return { suffix };
}

test.setTimeout(60_000);

test("creating a notebook and a discussion confirms via the Explorer tree alone, with no raw API response, uuid, or success message", async ({
  page,
  context,
}) => {
  const { suffix } = await signInFreshUser(page, context, "e2e-creator-ui");

  const notebookName = `E2E creator-ui notebook ${suffix}`;
  const discussionName = `E2E creator-ui discussion ${suffix}`;

  // Anything shaped like the raw JSON response (a quoted field name
  // followed by a colon) must never appear anywhere on the page.
  const jsonShapedText = page.getByText(/"(id|created_at|user_id)"\s*:/);
  // Nor a raw uuid -- "Add a discussion to this notebook" used to
  // identify the notebook by its id ("Notebook: 7df169f1-...").
  const uuidShapedText = page.getByText(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  // The "... created." confirmations are gone entirely: the row
  // appearing in the Explorer tree is the confirmation.
  const successConfirmation = page.getByText(/\bcreated\./);

  await page.getByLabel("Name:").first().fill(notebookName);
  await page.getByRole("button", { name: "Create notebook" }).click();

  // The notebook showing up in the Explorer is now the only confirmation.
  await expect(
    page.getByRole("treeitem", { name: notebookName }),
  ).toBeVisible();
  await expect(jsonShapedText).toHaveCount(0);
  // "Add a discussion to this notebook" is now showing -- this is
  // exactly where the raw uuid used to appear, and it must now carry no
  // notebook-identifying text at all (neither id nor name).
  await expect(
    page.getByText("Add a discussion to this notebook"),
  ).toBeVisible();
  await expect(uuidShapedText).toHaveCount(0);
  await expect(successConfirmation).toHaveCount(0);

  await page.getByLabel("Name:").last().fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();

  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toBeVisible();
  await expect(jsonShapedText).toHaveCount(0);
  await expect(successConfirmation).toHaveCount(0);
});

test("a duplicate discussion name in the same notebook is rejected with a visible error, but the same name in a different notebook is allowed", async ({
  page,
  context,
}) => {
  const { suffix } = await signInFreshUser(page, context, "e2e-dup-discussion");

  const firstNotebookName = `E2E dup notebook A ${suffix}`;
  const secondNotebookName = `E2E dup notebook B ${suffix}`;
  const discussionName = `E2E dup discussion ${suffix}`;

  await page.getByLabel("Name:").first().fill(firstNotebookName);
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(
    page.getByText("Add a discussion to this notebook"),
  ).toBeVisible();

  await page.getByLabel("Name:").last().fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toHaveCount(1);

  // Same name, same notebook -- rejected, with a visible error, and no
  // second row created.
  await page.getByLabel("Name:").last().fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByText(
      `This notebook already has a discussion named "${discussionName}". Pick a different name.`,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toHaveCount(1);

  // Case and surrounding whitespace don't get a user around it either --
  // the check is trimmed and case-insensitive on purpose.
  await page
    .getByLabel("Name:")
    .last()
    .fill(`  ${discussionName.toUpperCase()} `);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(page.getByText(/already has a discussion named/)).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toHaveCount(1);

  // A *different* notebook may reuse the name freely -- this validation
  // is deliberately scoped per-notebook, not global.
  await page.getByLabel("Name:").first().fill(secondNotebookName);
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(
    page.getByRole("treeitem", { name: secondNotebookName }),
  ).toBeVisible();

  await page.getByLabel("Name:").last().fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toHaveCount(2);
  await expect(page.getByText(/already has a discussion named/)).toHaveCount(0);
});

test("buttons render with real visual treatment, distinct from static text and from a disabled state", async ({
  page,
  context,
}) => {
  await signInFreshUser(page, context, "e2e-button-style");

  // An enabled button: a real <button> element with an actual border and
  // background — not plain inline text.
  const createNotebookButton = page.getByRole("button", {
    name: "Create notebook",
  });
  await expect(createNotebookButton).toBeVisible();
  // border-style alone isn't a reliable signal here — Tailwind's Preflight
  // resets border-style to "solid" globally (with 0 width) so that adding
  // a width later doesn't also require setting a style; border-width is
  // the part that's actually zero on unstyled elements.
  await expect(createNotebookButton).toHaveCSS("border-width", "1px");
  const backgroundColor = await createNotebookButton.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(backgroundColor).not.toBe("transparent");
  await expect(createNotebookButton).toHaveCSS("cursor", "pointer");

  // A disabled button (the header toolbar's not-yet-wired controls) still
  // looks like a button, but visibly distinct in its disabled state.
  const disabledButton = page.getByRole("button", { name: "New Notebook" });
  await expect(disabledButton).toBeVisible();
  await expect(disabledButton).toBeDisabled();
  await expect(disabledButton).toHaveCSS("border-width", "1px");
  await expect(disabledButton).toHaveCSS("cursor", "not-allowed");

  // Static text (a heading) must not pick up button styling — proves the
  // fix is scoped to real buttons, not a blanket visual change.
  const heading = page.getByRole("heading", { name: "Notebook creator" });
  await expect(heading).toHaveCSS("border-width", "0px");
});
