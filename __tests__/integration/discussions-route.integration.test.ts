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

// The route reads the session via next/headers' cookies(), which only works
// inside Next's own request-scoped AsyncLocalStorage. Since we call the
// route handler directly (not through a running Next server), next/headers
// is mocked so cookies() returns whatever this test currently wants the
// "incoming request" to carry.
let currentCookies: CookieRecord[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => currentCookies,
    get: (name: string) => currentCookies.find((c) => c.name === name),
    set: () => {},
  }),
}));

const { POST, GET, DELETE } = await import("@/app/api/discussions/route");

function makeDeleteRequest(id?: string) {
  const url = id
    ? `http://localhost/api/discussions?id=${id}`
    : "http://localhost/api/discussions";
  return new Request(url, { method: "DELETE" });
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/discussions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(id?: string) {
  const url = id
    ? `http://localhost/api/discussions?id=${id}`
    : "http://localhost/api/discussions";
  return new Request(url);
}

describe("/api/discussions", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    // Full reset so this file's run starts from a known-clean local DB —
    // files run sequentially (fileParallelism: false) so resets across
    // integration files can't race each other.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    // Local-only grant: the hosted project already grants these by
    // default, the local CLI stack does not (see other integration tests
    // for the same reasoning).
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebooks, " +
        "public.discussions, public.responses, public.execution_locks " +
        "TO anon, authenticated, service_role;",
    );

    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;

    // The route itself calls utils/supabase/server.ts's createClient(),
    // which reads these directly — each integration test file runs in its
    // own isolated worker, so this has to be set here too, not just in
    // execute-route's beforeAll.
    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;

    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
  }, 60000);

  async function createSignedInUser(): Promise<{
    userId: string;
    cookies: CookieRecord[];
  }> {
    const email = `discussions-route-${Date.now()}-${Math.random()
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

    return { userId: created.user.id, cookies };
  }

  test("creates a discussion owned by the caller under their own notebook", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;

    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Notebook for discussion test" })
      .select()
      .single();
    expect(notebookError).toBeNull();

    const response = await POST(
      makeRequest({ notebookId: notebook!.id, name: "My Discussion" }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.user_id).toBe(userId);
    expect(body.notebook_id).toBe(notebook!.id);
    expect(body.name).toBe("My Discussion");

    const { data: rows, error } = await admin
      .from("discussions")
      .select("*")
      .eq("id", body.id);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows?.[0].user_id).toBe(userId);
  });

  // Persistence audit findings B & C: discussion names must be unique
  // within a notebook, enforced by discussions_notebook_id_normalized_
  // name_idx (20260916210914), not just NotebookCreator's own separate,
  // racy client-side check.
  test("returns 409, and creates nothing, when the notebook already has a discussion with the same name", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;

    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Notebook for dup-name test" })
      .select()
      .single();
    expect(notebookError).toBeNull();

    const first = await POST(
      makeRequest({ notebookId: notebook!.id, name: "Baseline" }),
    );
    expect(first.status).toBe(201);

    const second = await POST(
      makeRequest({ notebookId: notebook!.id, name: "Baseline" }),
    );
    const secondBody = await second.json();
    expect(second.status).toBe(409);
    expect(secondBody.error).toBe(
      'This notebook already has a discussion named "Baseline". Pick a different name.',
    );

    const { data: rows, error } = await admin
      .from("discussions")
      .select("id")
      .eq("notebook_id", notebook!.id);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
  });

  test("the uniqueness constraint is trimmed and case-insensitive, matching the client-side check's own normalization", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;

    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Notebook for normalized dup test" })
      .select()
      .single();
    expect(notebookError).toBeNull();

    const first = await POST(
      makeRequest({ notebookId: notebook!.id, name: "Baseline" }),
    );
    expect(first.status).toBe(201);

    const second = await POST(
      makeRequest({ notebookId: notebook!.id, name: "  baseline  " }),
    );
    expect(second.status).toBe(409);
  });

  test("the same discussion name is allowed in a different notebook", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;

    const { data: notebookA, error: notebookAError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Notebook A for cross-notebook test" })
      .select()
      .single();
    expect(notebookAError).toBeNull();
    const { data: notebookB, error: notebookBError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Notebook B for cross-notebook test" })
      .select()
      .single();
    expect(notebookBError).toBeNull();

    const first = await POST(
      makeRequest({ notebookId: notebookA!.id, name: "Baseline" }),
    );
    expect(first.status).toBe(201);

    const second = await POST(
      makeRequest({ notebookId: notebookB!.id, name: "Baseline" }),
    );
    expect(second.status).toBe(201);
  });

  test("returns 401 when there is no authenticated user", async () => {
    currentCookies = [];

    const response = await POST(
      makeRequest({
        notebookId: "00000000-0000-0000-0000-000000000000",
        name: "Nope",
      }),
    );

    expect(response.status).toBe(401);
  });

  test("returns 400 for a malformed request body", async () => {
    const { cookies } = await createSignedInUser();
    currentCookies = cookies;

    const response = await POST(
      new Request("http://localhost/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not valid json{{{",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();
  });

  test("returns 404, and creates nothing, when the notebook belongs to another user", async () => {
    const userA = await createSignedInUser();
    const userB = await createSignedInUser();

    const { data: notebookA, error: notebookAError } = await admin
      .from("notebooks")
      .insert({ user_id: userA.userId, name: "User A's notebook" })
      .select()
      .single();
    expect(notebookAError).toBeNull();

    currentCookies = userB.cookies;
    const response = await POST(
      makeRequest({
        notebookId: notebookA!.id,
        name: "Should not be created",
      }),
    );

    expect(response.status).toBe(404);

    const { data: rows, error } = await admin
      .from("discussions")
      .select("*")
      .eq("notebook_id", notebookA!.id);
    expect(error).toBeNull();
    expect(rows).toHaveLength(0);
  });

  test("GET returns only the caller's own discussions, embedding each one's own notebook name, not another user's", async () => {
    const userA = await createSignedInUser();
    const userB = await createSignedInUser();

    const { data: notebookA, error: notebookAError } = await admin
      .from("notebooks")
      .insert({ user_id: userA.userId, name: "User A's notebook" })
      .select()
      .single();
    expect(notebookAError).toBeNull();

    const { data: notebookB, error: notebookBError } = await admin
      .from("notebooks")
      .insert({ user_id: userB.userId, name: "User B's notebook" })
      .select()
      .single();
    expect(notebookBError).toBeNull();

    const { error: discussionAError } = await admin.from("discussions").insert({
      notebook_id: notebookA!.id,
      user_id: userA.userId,
      name: "User A's discussion",
    });
    expect(discussionAError).toBeNull();

    const { error: discussionBError } = await admin.from("discussions").insert({
      notebook_id: notebookB!.id,
      user_id: userB.userId,
      name: "User B's discussion",
    });
    expect(discussionBError).toBeNull();

    currentCookies = userA.cookies;
    const responseA = await GET(makeGetRequest());
    expect(responseA.status).toBe(200);
    const bodyA = await responseA.json();
    expect(bodyA).toHaveLength(1);
    expect(bodyA[0].name).toBe("User A's discussion");
    expect(bodyA[0].user_id).toBe(userA.userId);
    expect(bodyA[0].notebooks.name).toBe("User A's notebook");

    currentCookies = userB.cookies;
    const responseB = await GET(makeGetRequest());
    expect(responseB.status).toBe(200);
    const bodyB = await responseB.json();
    expect(bodyB).toHaveLength(1);
    expect(bodyB[0].name).toBe("User B's discussion");
    expect(bodyB[0].user_id).toBe(userB.userId);
    expect(bodyB[0].notebooks.name).toBe("User B's notebook");
  });

  test("GET returns 401 when there is no authenticated user", async () => {
    currentCookies = [];

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(401);
  });

  // Seeds a notebook with two discussions and one response row under the
  // first, so cascade behavior is observable rather than assumed.
  async function seedDeletableDiscussions(userId: string) {
    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Notebook for delete test" })
      .select()
      .single();
    expect(notebookError).toBeNull();

    const { data: discussions, error: discussionsError } = await admin
      .from("discussions")
      .insert([
        { notebook_id: notebook!.id, user_id: userId, name: "Doomed" },
        { notebook_id: notebook!.id, user_id: userId, name: "Kept" },
      ])
      .select();
    expect(discussionsError).toBeNull();

    const doomed = discussions!.find((d) => d.name === "Doomed")!;
    const kept = discussions!.find((d) => d.name === "Kept")!;

    const { error: responseError } = await admin.from("responses").insert({
      discussion_id: doomed.id,
      user_id: userId,
      prompt_text: "goes away with its discussion",
      response: "ok",
      model: "claude-sonnet-4-6",
      cell_type: "assistant",
    });
    expect(responseError).toBeNull();

    return { notebook: notebook!, doomed, kept };
  }

  test("DELETE removes the discussion and cascades to its responses, leaving siblings alone", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;
    const { doomed, kept } = await seedDeletableDiscussions(userId);

    const response = await DELETE(makeDeleteRequest(doomed.id));
    expect(response.status).toBe(200);

    const { data: doomedRows } = await admin
      .from("discussions")
      .select("id")
      .eq("id", doomed.id);
    expect(doomedRows).toHaveLength(0);

    // Proven, not inferred from the ON DELETE CASCADE declaration.
    const { data: responseRows } = await admin
      .from("responses")
      .select("id")
      .eq("discussion_id", doomed.id);
    expect(responseRows).toHaveLength(0);

    const { data: keptRows } = await admin
      .from("discussions")
      .select("id")
      .eq("id", kept.id);
    expect(keptRows).toHaveLength(1);
  });

  test("DELETE returns 404, and deletes nothing, when the discussion belongs to another user", async () => {
    const owner = await createSignedInUser();
    currentCookies = owner.cookies;
    const { doomed } = await seedDeletableDiscussions(owner.userId);

    const other = await createSignedInUser();
    currentCookies = other.cookies;

    const response = await DELETE(makeDeleteRequest(doomed.id));
    expect(response.status).toBe(404);

    const { data: rows } = await admin
      .from("discussions")
      .select("id")
      .eq("id", doomed.id);
    expect(rows).toHaveLength(1);
  });

  test("DELETE returns 401 when there is no authenticated user", async () => {
    currentCookies = [];

    const response = await DELETE(makeDeleteRequest(crypto.randomUUID()));

    expect(response.status).toBe(401);
  });

  test("DELETE returns 400 when id is missing", async () => {
    const { cookies } = await createSignedInUser();
    currentCookies = cookies;

    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(400);
  });

  test("DELETE returns 409, and deletes nothing, when the discussion holds an active (non-stale) execution lock", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;
    const { doomed } = await seedDeletableDiscussions(userId);

    const { error: lockError } = await admin.from("execution_locks").insert({
      user_id: userId,
      discussion_id: doomed.id,
      acquired_at: new Date().toISOString(),
    });
    expect(lockError).toBeNull();

    const response = await DELETE(makeDeleteRequest(doomed.id));
    expect(response.status).toBe(409);

    const { data: rows } = await admin
      .from("discussions")
      .select("id")
      .eq("id", doomed.id);
    expect(rows).toHaveLength(1);
  });

  test("DELETE is not blocked by a *sibling* discussion's active execution lock", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;
    const { doomed, kept } = await seedDeletableDiscussions(userId);

    // The lock belongs to the sibling, not the one being deleted — the
    // notebook-level check would block here, this one must not.
    const { error: lockError } = await admin.from("execution_locks").insert({
      user_id: userId,
      discussion_id: kept.id,
      acquired_at: new Date().toISOString(),
    });
    expect(lockError).toBeNull();

    const response = await DELETE(makeDeleteRequest(doomed.id));
    expect(response.status).toBe(200);

    const { data: rows } = await admin
      .from("discussions")
      .select("id")
      .eq("id", doomed.id);
    expect(rows).toHaveLength(0);
  });

  test("DELETE succeeds normally when the discussion's own execution lock is stale", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;
    const { doomed } = await seedDeletableDiscussions(userId);

    // Well past execution_lock_stale_after() (5 minutes) — a lock this
    // old represents a run that died, not one still in flight.
    const { error: lockError } = await admin.from("execution_locks").insert({
      user_id: userId,
      discussion_id: doomed.id,
      acquired_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect(lockError).toBeNull();

    const response = await DELETE(makeDeleteRequest(doomed.id));
    expect(response.status).toBe(200);

    const { data: rows } = await admin
      .from("discussions")
      .select("id")
      .eq("id", doomed.id);
    expect(rows).toHaveLength(0);
  });
});
