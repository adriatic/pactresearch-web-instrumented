import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the fix for the raw-JSON result block: after a run completes,
// the page must show the properly rendered markdown response (and
// nothing else) -- never the raw { "response": ..., "resolved_model":
// ... } wrapper. This display is sourced directly from /api/execute's
// own resolved body (run()'s success branch), not from the
// Realtime "live preview" channel -- Realtime delivery is best-effort and
// this display must be correct even when no Realtime event ever arrives,
// which local testing has confirmed is a real, reproducible failure mode
// of Supabase Realtime's postgres_changes (see the investigation this
// fix grew out of). A failed run shows only the server's generic error
// message plus its errorId, never the raw body.
//
// /api/execute is mocked at the browser network layer (page.route)
// rather than exercised for real: this clone's local dev environment has
// no ANTHROPIC_API_KEY configured, so a genuine successful run isn't
// reproducible locally, and relying on that absence to test the failure
// path would make the test's premise silently depend on incidental local
// env state. Mocking both a success and a failure response directly is
// deterministic and exercises the exact same client code path either way
// (POST /api/execute -> success/failure branch in run()) --
// nothing about how the client processes the response differs from a
// real call. Deliberately not mocking the Realtime channel at all -- the
// success test must pass whether or not a postgres_changes event ever
// arrives, which is exactly the guarantee this fix provides.

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

async function seedSignedInUserWithDiscussion(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  emailPrefix: string,
) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${emailPrefix}-${suffix}@example.com`;
  const password = "correct horse battery staple 15!";

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
    .insert({ user_id: userId, name: `E2E execute-result notebook ${suffix}` })
    .select()
    .single();
  if (notebookError) throw notebookError;

  const { error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: `E2E execute-result discussion ${suffix}`,
    })
    .select()
    .single();
  if (discussionError) throw discussionError;

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

  // Waits for the auto-selected discussion's initial load (its history +
  // persisted draft fetch, see useDiscussionExecution's saveThenLoad) to
  // actually finish before returning control to the test. Without this,
  // filling the composer immediately after goto() races that fetch: if it
  // resolves after the fill, its setPromptText(persisted draft) clobbers
  // whatever was just typed with this fresh discussion's empty draft --
  // a real, pre-existing race in the app's initial-load effect, not
  // something this suite should paper over by asserting against it.
  // "Switched in ..." is set at the very end of that same effect, so its
  // appearance is a reliable signal the race window has closed.
  await page.getByText(/Switched in/).waitFor({ timeout: 15_000 });
}

// Covers every field name that could leak from either a success body
// ({ response, resolved_model }) or a failure body ({ error, errorId }).
const jsonShapedText = /"(response|resolved_model|error|errorId)"\s*:/;

test.setTimeout(60_000);

test("a successful run never shows the raw JSON result block", async ({
  page,
  context,
}) => {
  await seedSignedInUserWithDiscussion(page, context, "e2e-execute-success");

  const markdownResponse = "# Mocked heading\n\nA **bold** mocked response.";
  await page.route("**/api/execute", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: markdownResponse,
        resolved_model: "claude-sonnet-4-6-mock",
      }),
    }),
  );

  const composer = page.locator("textarea");
  await composer.fill("Trigger a mocked successful run");
  const runButton = page.getByRole("button", { name: "Run" });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    runButton.click(),
  ]);
  // Not toBeEnabled(): a successful run clears the composer (see the
  // persistence-audit fix to run()), so Run correctly goes back to
  // disabled -- an empty composer, not a stuck loading state. Loading
  // itself finishing is confirmed by the "Running..." label being gone.
  await expect(runButton).not.toHaveText("Running...");
  await expect(runButton).toBeDisabled();
  await expect(composer).toHaveValue("");

  // The real fix: the response must actually render as markdown, sourced
  // from /api/execute's own body -- not merely "no raw JSON block".
  await expect(
    page.getByRole("heading", { name: "Mocked heading" }),
  ).toBeVisible();
  await expect(page.locator("strong", { hasText: "bold" })).toBeVisible();
  await expect(page.getByText(jsonShapedText)).toHaveCount(0);
  // The literal markdown source ("# Mocked heading") must not appear as
  // raw text anywhere -- it must only exist as a rendered <h1>.
  await expect(page.getByText("# Mocked heading")).toHaveCount(0);
});

test("a failed run shows the generic message and errorId, never the raw JSON body", async ({
  page,
  context,
}) => {
  await seedSignedInUserWithDiscussion(page, context, "e2e-execute-failure");

  await page.route("**/api/execute", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error:
          "Execution failed. Please try again or contact support if this persists.",
        errorId: "test-error-id-123",
      }),
    }),
  );

  const composer = page.locator("textarea");
  await composer.fill("Trigger a mocked failed run");
  const runButton = page.getByRole("button", { name: "Run" });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    runButton.click(),
  ]);

  // The error path must still work: a clean, human-readable message, with
  // the errorId available for correlating back to the server-side log.
  await expect(
    page.getByText(
      "Execution failed. Please try again or contact support if this persists. (error id: test-error-id-123)",
    ),
  ).toBeVisible();
  await expect(page.getByText(jsonShapedText)).toHaveCount(0);
});
