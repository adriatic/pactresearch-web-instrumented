import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the resizable sidebar (react-resizable-panels): dragging the
// separator between the Explorer sidebar and the main panel actually
// changes the sidebar's width, and dragging far past either constraint
// clamps to the configured min/max rather than growing unbounded or
// shrinking to nothing.

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

test("dragging the sidebar's resize handle changes its width within the configured min/max bounds", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-resize-${suffix}@example.com`;
  const password = "correct horse battery staple 12!";

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

  // Scoped to react-resizable-panels' own [data-separator] attribute, not
  // a plain role query — the sidebar also has a genuine <hr> (between
  // Explorer and NotebookCreator), which carries an implicit
  // role="separator" too and would otherwise collide.
  //
  // Narrowed further to a *direct child* of the outermost group: there is
  // now a second, nested vertical Group (composer over discussion
  // content) with its own separator, and a bare [data-separator] query
  // matches both. The library emits no orientation attribute to
  // discriminate on, so structure is what's left.
  const separator = page
    .locator("[data-group]")
    .first()
    .locator("> [data-separator]");
  const sidebarPanel = page.locator("[data-panel]").first();

  await expect(separator).toBeVisible();
  const initialWidth = (await sidebarPanel.boundingBox())!.width;
  // Matches Panel's defaultSize={280} in Workspace.tsx.
  expect(Math.round(initialWidth)).toBe(280);

  const separatorBox = (await separator.boundingBox())!;
  const startX = separatorBox.x + separatorBox.width / 2;
  const startY = separatorBox.y + separatorBox.height / 2;

  // Drag to a specific, different width within bounds (180-560) and
  // confirm the panel actually resized to reflect it — not just that
  // some resize happened.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(400, startY);
  await page.mouse.up();

  const resizedWidth = (await sidebarPanel.boundingBox())!.width;
  expect(resizedWidth).not.toBe(initialWidth);
  expect(Math.round(resizedWidth)).toBeGreaterThan(350);
  expect(Math.round(resizedWidth)).toBeLessThan(450);

  // Drag far past the configured maximum (560) — confirm it clamps
  // rather than growing to swallow the screen.
  const newSeparatorBox = (await separator.boundingBox())!;
  await page.mouse.move(
    newSeparatorBox.x + newSeparatorBox.width / 2,
    newSeparatorBox.y + newSeparatorBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(1200, startY);
  await page.mouse.up();

  const clampedMaxWidth = (await sidebarPanel.boundingBox())!.width;
  expect(Math.round(clampedMaxWidth)).toBeLessThanOrEqual(560);
  expect(Math.round(clampedMaxWidth)).toBeGreaterThan(450);

  // Drag far past the configured minimum (180) — confirm it clamps
  // rather than shrinking to unusable.
  const secondSeparatorBox = (await separator.boundingBox())!;
  await page.mouse.move(
    secondSeparatorBox.x + secondSeparatorBox.width / 2,
    secondSeparatorBox.y + secondSeparatorBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(0, startY);
  await page.mouse.up();

  const clampedMinWidth = (await sidebarPanel.boundingBox())!.width;
  expect(Math.round(clampedMinWidth)).toBeGreaterThanOrEqual(180);
  expect(Math.round(clampedMinWidth)).toBeLessThan(250);
});
