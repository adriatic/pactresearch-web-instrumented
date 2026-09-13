import { beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function runLocalSql(sql: string): void {
  execFileSync("npx", ["supabase", "db", "query", "--local", sql], {
    stdio: "inherit",
  });
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  const output = execFileSync("npx", ["supabase", "status", "-o", "json"], {
    encoding: "utf-8",
  });
  return JSON.parse(output) as LocalSupabaseStatus;
}

type CookieRecord = { name: string; value: string };

// Same reasoning as execute-route.integration.test.ts: the route reads
// the session via next/headers' cookies(), which only works inside
// Next's own request-scoped AsyncLocalStorage -- mocked so calling the
// route handler directly (no running Next server) still works.
let currentCookies: CookieRecord[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => currentCookies,
    get: (name: string) => currentCookies.find((c) => c.name === name),
    set: () => {},
  }),
}));

const { GET, PATCH } = await import("@/app/api/admin/settings/route");

function makePatchRequest(body: unknown) {
  return new Request("http://localhost/api/admin/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET/PATCH /api/admin/settings", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO anon, authenticated, service_role;",
    );
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles " +
        "TO anon, authenticated, service_role;",
    );

    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;

    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;

    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
  }, 60000);

  async function createSignedInUser(
    isAdminUser: boolean,
  ): Promise<CookieRecord[]> {
    const email = `admin-settings-route-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 6!";

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw createError ?? new Error("failed to create test user");
    }

    if (isAdminUser) {
      const { error: grantError } = await admin
        .from("user_roles")
        .insert({ user_id: created.user.id, is_admin: true });
      if (grantError) throw grantError;
    }

    const cookies: CookieRecord[] = [];
    const jarClient = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll: () => cookies,
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => {
            const existing = cookies.find((c) => c.name === name);
            if (existing) {
              existing.value = value;
            } else {
              cookies.push({ name, value });
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

    return cookies;
  }

  test("GET returns 401 with no session", async () => {
    currentCookies = [];
    const response = await GET();
    expect(response.status).toBe(401);
  });

  test("GET returns 403 for a non-admin user", async () => {
    currentCookies = await createSignedInUser(false);
    const response = await GET();
    expect(response.status).toBe(403);
  });

  test("GET returns the current value for an admin user", async () => {
    currentCookies = await createSignedInUser(true);
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.max_tokens).toBe(40000);
  });

  test("PATCH returns 403 for a non-admin user and does not change the value", async () => {
    currentCookies = await createSignedInUser(false);
    const response = await PATCH(makePatchRequest({ maxTokens: 5 }));
    expect(response.status).toBe(403);

    const { data } = await admin
      .from("app_settings")
      .select("max_tokens")
      .eq("id", 1)
      .single();
    expect(data?.max_tokens).toBe(40000);
  });

  test("PATCH rejects a non-positive-integer value for an admin user", async () => {
    currentCookies = await createSignedInUser(true);
    const response = await PATCH(makePatchRequest({ maxTokens: -5 }));
    expect(response.status).toBe(400);
  });

  test("PATCH updates the value for an admin user", async () => {
    currentCookies = await createSignedInUser(true);
    const response = await PATCH(makePatchRequest({ maxTokens: 777 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.max_tokens).toBe(777);

    const { data } = await admin
      .from("app_settings")
      .select("max_tokens")
      .eq("id", 1)
      .single();
    expect(data?.max_tokens).toBe(777);
  });
});
