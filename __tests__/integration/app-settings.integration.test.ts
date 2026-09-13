import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Proves the RLS policies added in 20260913035840_app_settings_max_tokens:
// any authenticated user can read the single global row, but only an
// admin (per user_roles/is_admin) can update it -- a non-admin's update
// attempt must silently affect zero rows (RLS's `using` clause filters it
// out, same as any other select/update/delete policy -- unlike insert,
// which errors outright, see is-admin.integration.test.ts), not throw an
// error and not change the value.

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

describe("app_settings RLS", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    // Full reset so this file's run starts from a known-clean local DB --
    // files run sequentially (fileParallelism: false in
    // vitest.integration.config.mts) so the resets can't race each other.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    // Local-only grant, same reasoning as the other integration tests: the
    // hosted project already has these grants by default, the local CLI
    // stack does not.
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
    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
  }, 60000);

  async function createSignedInUser(): Promise<{
    userId: string;
    client: SupabaseClient;
  }> {
    const email = `app-settings-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 5!";

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw createError ?? new Error("failed to create test user");
    }

    const cookies: { name: string; value: string }[] = [];
    const client = createServerClient(API_URL, ANON_KEY, {
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

    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;

    return { userId: created.user.id, client };
  }

  test("the migration seeds exactly one row, defaulting to max_tokens=40000", async () => {
    const { data, error } = await admin.from("app_settings").select("*");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ id: 1, max_tokens: 40000 });
  });

  test("any authenticated user can read the current setting", async () => {
    const { client } = await createSignedInUser();

    const { data, error } = await client
      .from("app_settings")
      .select("max_tokens")
      .eq("id", 1)
      .single();

    expect(error).toBeNull();
    expect(data?.max_tokens).toBe(40000);
  });

  test("a non-admin user cannot update app_settings -- RLS silently blocks it", async () => {
    const { client } = await createSignedInUser();

    const { data: updated, error: updateError } = await client
      .from("app_settings")
      .update({ max_tokens: 999 })
      .eq("id", 1)
      .select();

    expect(updateError).toBeNull();
    expect(updated).toHaveLength(0);

    const { data: afterAttempt, error: afterError } = await admin
      .from("app_settings")
      .select("max_tokens")
      .eq("id", 1)
      .single();
    expect(afterError).toBeNull();
    expect(afterAttempt?.max_tokens).toBe(40000);
  });

  test("an admin user can update app_settings", async () => {
    const { userId, client } = await createSignedInUser();
    const { error: grantError } = await admin
      .from("user_roles")
      .insert({ user_id: userId, is_admin: true });
    expect(grantError).toBeNull();

    const { data: updated, error: updateError } = await client
      .from("app_settings")
      .update({ max_tokens: 12345 })
      .eq("id", 1)
      .select();

    expect(updateError).toBeNull();
    expect(updated).toHaveLength(1);
    expect(updated?.[0].max_tokens).toBe(12345);

    const { data: afterUpdate, error: afterError } = await admin
      .from("app_settings")
      .select("max_tokens")
      .eq("id", 1)
      .single();
    expect(afterError).toBeNull();
    expect(afterUpdate?.max_tokens).toBe(12345);
  });
});
