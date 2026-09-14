import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies a response containing markdown (a heading, bold text, a list)
// renders as real formatting -- actual heading/strong/list elements --
// rather than showing the raw source characters (#, **, -) as visible
// text. The history view and the live-streaming view share the exact
// same rendering component (MarkdownResponse), so exercising the history
// view is sufficient evidence for both; seeding a response row directly
// (same pattern as fixed-layout.spec.ts) keeps this deterministic and
// avoids a real, costly, non-deterministic call to the Anthropic API
// just to get markdown-shaped text back.

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

test("a response containing a heading, bold text, and a list renders as real markdown, not raw source", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-markdown-${suffix}@example.com`;
  const password = "correct horse battery staple 11!";
  const notebookName = `E2E markdown notebook ${suffix}`;
  const discussionName = `E2E markdown discussion ${suffix}`;
  const headingText = `Real Heading ${suffix}`;

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
    .insert({ user_id: userId, name: notebookName })
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

  const markdownResponse = [
    `# ${headingText}`,
    "",
    "This has **bold text** and a list:",
    "",
    "- First item",
    "- Second item",
    "- Third item",
  ].join("\n");

  const { error: responseError } = await admin.from("responses").insert({
    discussion_id: discussion!.id,
    user_id: userId,
    prompt_text: "Give me a heading, bold text, and a list",
    response: markdownResponse,
    resolved_model: "claude-sonnet-4-6",
  });
  expect(responseError).toBeNull();

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

  // findLatestDiscussion picks this discussion (the only one that
  // exists), so its history loads without any manual selection.

  // Real elements, not raw source text.
  await expect(page.getByRole("heading", { name: headingText })).toBeVisible();
  await expect(page.locator("strong", { hasText: "bold text" })).toBeVisible();
  const listItems = page.getByRole("listitem");
  await expect(listItems).toHaveCount(3);
  await expect(listItems.nth(0)).toHaveText("First item");
  await expect(listItems.nth(1)).toHaveText("Second item");
  await expect(listItems.nth(2)).toHaveText("Third item");

  // The raw markdown syntax itself must not be visible anywhere on the
  // page -- proof this is rendered formatting, not source text with a
  // heading/strong/list element that merely happens to also exist.
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain(`# ${headingText}`);
  expect(bodyText).not.toContain("**bold text**");
  expect(bodyText).not.toContain("- First item");
});
