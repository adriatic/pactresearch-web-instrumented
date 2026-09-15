import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// The composer's native textarea resize grip is replaced by a real
// draggable panel divider between the composer and the discussion content
// below it, using the same react-resizable-panels split already used for
// the Explorer/main-panel boundary. Two things are pinned here: the
// native grip is genuinely off (not merely visually hidden), and dragging
// the divider actually reflows the composer's height.

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

test("the composer is sized by a real draggable divider, not a native textarea resize grip", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-composer-divider-${suffix}@example.com`;
  const password = "correct horse battery staple 24!";

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

  await page.goto("/");

  // The native grip is off, per computed style — not just unstyled.
  const textarea = page.getByLabel("Prompt");
  await expect(textarea).toBeVisible();
  expect(await textarea.evaluate((el) => getComputedStyle(el).resize)).toBe(
    "none",
  );

  // The composer's own divider: the vertical Group is the nested one, so
  // its separator is the one that is *not* a direct child of the
  // outermost (horizontal) group. The library emits no orientation
  // attribute, so structure is what discriminates them.
  const composerDivider = page
    .locator("[data-group] [data-group] > [data-separator]")
    .first();
  await expect(composerDivider).toBeVisible();

  // .last(): the outer main Panel also *contains* the textarea (it's an
  // ancestor), so filtering by it matches both. The innermost match --
  // the composer's own Panel -- is the later one in document order.
  const composerPanel = page
    .locator("[data-panel]")
    .filter({ has: textarea })
    .last();
  const initialHeight = (await composerPanel.boundingBox())!.height;
  // Matches Panel's defaultSize={140} in Workspace.tsx.
  expect(Math.round(initialHeight)).toBe(140);

  const dividerBox = (await composerDivider.boundingBox())!;
  const startX = dividerBox.x + dividerBox.width / 2;
  const startY = dividerBox.y + dividerBox.height / 2;

  // Drag down to a specific, larger height within bounds (64-480) and
  // confirm the composer actually grew to reflect it.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 120);
  await page.mouse.up();

  const resizedHeight = (await composerPanel.boundingBox())!.height;
  expect(resizedHeight).toBeGreaterThan(initialHeight + 80);
  expect(Math.round(resizedHeight)).toBeLessThanOrEqual(480);

  // Drag far past the configured maximum (480) — confirm it clamps rather
  // than swallowing the whole panel.
  const movedBox = (await composerDivider.boundingBox())!;
  await page.mouse.move(
    movedBox.x + movedBox.width / 2,
    movedBox.y + movedBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + 4000);
  await page.mouse.up();

  const clampedHeight = (await composerPanel.boundingBox())!.height;
  expect(Math.round(clampedHeight)).toBeLessThanOrEqual(480);
});
