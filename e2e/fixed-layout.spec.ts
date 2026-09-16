import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the fixed-layout shell (Workspace.tsx): a discussion with
// enough response history to require scrolling doesn't push the composer
// or the Explorer sidebar out of view — only the middle content region
// scrolls. Confirms both the composer (visible + usable) and the sidebar
// (visible + a discussion link still clickable) stay reachable without
// the page itself having to scroll to find them.

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

test("the composer and Explorer sidebar stay fixed and visible when discussion content is tall enough to scroll", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-fixed-layout-${suffix}@example.com`;
  const password = "correct horse battery staple 10!";
  const notebookName = `E2E fixed-layout notebook ${suffix}`;
  const discussionName = `E2E fixed-layout discussion ${suffix}`;

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

  // Enough response rows, each with a long response body, to make the
  // discussion content region genuinely tall enough to require scrolling
  // in a normal viewport.
  const tallResponseText = "Lorem ipsum dolor sit amet. ".repeat(200);
  const responsesToInsert = Array.from({ length: 15 }, (_, i) => ({
    discussion_id: discussion!.id,
    user_id: userId,
    prompt_text: `Prompt ${i}`,
    response: `${tallResponseText} (response ${i})`,
    resolved_model: "claude-sonnet-4-6",
  }));
  const { error: responsesError } = await admin
    .from("responses")
    .insert(responsesToInsert);
  expect(responsesError).toBeNull();

  // Real session, real cookies — same pattern as the other E2E specs.
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
  // exists), so its notebook auto-expands and its history — 15 long
  // response entries — loads without any manual selection.
  const composer = page.locator("textarea");
  const runButton = page.getByRole("button", { name: "Run" });
  const discussionLink = page.getByRole("treeitem", {
    name: discussionName,
  });

  // History has genuinely rendered (proof the tall content is actually
  // present, not an empty page that would trivially pass a visibility
  // check).
  await expect(page.getByText("response 14")).toBeAttached();

  // The composer is visible and usable without scrolling the page to
  // find it — it's fixed above the scrolling content, not pushed below
  // 15 long response entries.
  await expect(composer).toBeVisible();
  await expect(runButton).toBeVisible();
  await composer.fill("Still reachable");
  await expect(composer).toHaveValue("Still reachable");

  // The Explorer sidebar and its discussion link are also still visible
  // and clickable — the tall content region didn't push the sidebar out
  // of view or make it unusable.
  await expect(discussionLink).toBeVisible();
  await discussionLink.click();

  // Confirm this is a real, scrollable region, not just a coincidentally
  // short page: the content area's scrollHeight exceeds its own visible
  // height (there is genuinely something to scroll), while the composer
  // and discussion link remained visible throughout without the test
  // ever needing to scroll the page itself to re-find them.
  const contentScrolls = await page.evaluate(() => {
    // <main> (DiscussionContent's own root) -> the scrollable wrapper div
    // (overflowY: auto) in Workspace.tsx. There's exactly one <main> on
    // this page.
    const region = document.querySelector("main")?.parentElement;
    return region ? region.scrollHeight > region.clientHeight : false;
  });
  expect(contentScrolls).toBe(true);
});
