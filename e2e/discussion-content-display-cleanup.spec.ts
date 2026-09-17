import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Three cosmetic-only display cleanups to DiscussionContent.tsx:
// 1. The "Execute tester" heading is gone -- meaningless placeholder text.
// 2. Each History entry shows its own real created_at, sourced from that
//    response row's own database value -- not an approximate client-side
//    timestamp. (Originally landed as a single header-level line next to
//    "Discussion: {name}" in 7986c92, sourced from only the *latest*
//    response -- wrong scope, since every older entry showed the same,
//    incorrect value once you scrolled past the latest one. Relocated
//    per-entry here.)
// 3. The "History" heading is gone -- same reasoning as (1).
//
// Verified across two discussions: one with an existing response (its
// entry's own timestamp must show and be correct, and the header line
// must carry none), one with none yet (no timestamp anywhere, and
// nothing crashes on the empty case).

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

  // 2: the discussion with a response shows that entry's own real, exact
  // timestamp -- inside the History entry itself, not on the
  // "Discussion: {name}" line, which must carry no timestamp at all.
  await withHistoryRow.click();
  const expectedTimestamp = knownCreatedAt.toLocaleString();
  await expect(
    page.getByText(`Discussion: ${discussionWithHistoryName}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(expectedTimestamp)).toBeVisible();

  // The discussion with no response yet shows no timestamp anywhere --
  // nothing crashes on the empty case, and nothing fabricates one.
  await withoutHistoryRow.click();
  await expect(
    page.getByText(`Discussion: ${discussionWithoutHistoryName}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(expectedTimestamp)).toHaveCount(0);
});

test("a discussion with multiple responses shows each one's own distinct timestamp, not a single shared value", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-per-entry-timestamp-${suffix}@example.com`;
  const password = "correct horse battery staple 33!";
  const notebookName = `E2E per-entry-timestamp notebook ${suffix}`;
  const discussionName = `E2E per-entry-timestamp discussion ${suffix}`;

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

  // Three responses, each at a distinct, known, fixed created_at -- far
  // enough apart (whole days) that their formatted timestamps can never
  // coincidentally collide.
  const timestamps = [
    new Date("2026-01-10T09:00:00.000Z"),
    new Date("2026-01-11T14:15:00.000Z"),
    new Date("2026-01-12T22:45:00.000Z"),
  ];
  for (const [i, ts] of timestamps.entries()) {
    const { error: cellError } = await admin.from("responses").insert({
      discussion_id: discussion!.id,
      user_id: userId,
      prompt_text: `prompt ${i}`,
      response: `response ${i}`,
      model: "claude-sonnet-4-6",
      resolved_model: "claude-sonnet-4-6-20260101",
      cell_type: "assistant",
      created_at: ts.toISOString(),
    });
    expect(cellError).toBeNull();
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

  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(discussionRow).toBeVisible();
  await discussionRow.click();

  // Each of the three formatted timestamps appears exactly once -- each
  // tied to its own entry, none shared or missing. The header line
  // ("Discussion: {name}") shows none of them.
  const discussionLine = page.getByText(`Discussion: ${discussionName}`, {
    exact: true,
  });
  await expect(discussionLine).toBeVisible();

  for (const ts of timestamps) {
    const formatted = ts.toLocaleString();
    await expect(page.getByText(formatted)).toHaveCount(1);
  }

  // The three formatted values are themselves genuinely distinct -- not
  // an accidental pass because two happened to format identically.
  const formattedTimestamps = timestamps.map((ts) => ts.toLocaleString());
  expect(new Set(formattedTimestamps).size).toBe(3);
});

test("the Live response section shows its own response's created_at, sourced from /api/execute's response_created_at", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-live-response-timestamp-${suffix}@example.com`;
  const password = "correct horse battery staple 34!";
  const notebookName = `E2E live-response-timestamp notebook ${suffix}`;
  const discussionName = `E2E live-response-timestamp discussion ${suffix}`;

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
    });
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

  // A fixed, known created_at returned by the mocked /api/execute --
  // deliberately distinct from "now" so the test proves this exact value
  // is what's rendered, not an accidental match with the current time.
  const knownCreatedAt = new Date("2026-02-01T08:00:00.000Z");

  await page.route("**/api/execute", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: "a live response",
        resolved_model: "claude-sonnet-4-6-mock",
        response_row_id: crypto.randomUUID(),
        response_created_at: knownCreatedAt.toISOString(),
      }),
    }),
  );

  await page.goto("/");
  await page.getByText(/Switched in/).waitFor({ timeout: 15_000 });

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

  await page.getByLabel("Prompt").fill("a prompt");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    page.locator("header").getByRole("button", { name: "Run" }).click(),
  ]);

  // Two legitimate matches, not a bug: this same successful run is also
  // appended into History (see history-live-append.spec.ts and the
  // persistence audit's finding A), which independently renders this
  // same response's same timestamp a second time. .first() disambiguates
  // without asserting away that (correct, unrelated) duplication.
  await expect(
    page.getByText(knownCreatedAt.toLocaleString()).first(),
  ).toBeVisible();
});
