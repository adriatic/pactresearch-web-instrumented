import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import {
  createAnthropicStreamHandler,
  mockAnthropicStreamedModel,
  mockAnthropicStreamedText,
} from "../mocks/handlers";

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

const { POST } = await import("@/app/api/execute/route");

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Minimal SSE stream for tests that only care about what request body was
// sent to Anthropic, not about incremental delta timing (unlike
// createAnthropicStreamHandler's multi-word, optionally-delayed stream).
function buildTinySseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events = [
    {
      type: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_tiny",
          type: "message",
          role: "assistant",
          model: mockAnthropicStreamedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    },
    {
      type: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    { type: "message_stop", data: { type: "message_stop" } },
  ];

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
}

describe("POST /api/execute", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;
  let userId: string;
  let discussionId: string;
  const email = `execute-route-${Date.now()}@example.com`;
  const password = "correct horse battery staple 1!";

  beforeAll(async () => {
    // Full reset so this file's run starts from a known-clean local DB,
    // same as the other integration test — files run sequentially
    // (fileParallelism: false in vitest.integration.config.mts) so the two
    // resets can't race each other.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    // Unlike the hosted project, the local CLI-provisioned Postgres does not
    // auto-grant anon/authenticated/service_role access to new tables (no
    // `auto_expose_new_tables`, see supabase/config.toml) — the hosted
    // project's grants were confirmed already present via
    // `supabase db query --linked`. This mirrors the existing probe-table
    // integration test's own local-only GRANT and touches no migration file.
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebooks, " +
        "public.discussions, public.responses, public.execution_locks " +
        "TO anon, authenticated, service_role;",
    );
    // Functions aren't auto-exposed locally either (same config.toml note
    // above covers "tables, views, sequences and functions").
    runLocalSql(
      "GRANT EXECUTE ON FUNCTION public.try_acquire_execution_lock" +
        "(uuid, uuid, interval) TO anon, authenticated, service_role;",
    );
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO anon, authenticated, service_role;",
    );

    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;

    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;
    // Fake, local-only placeholder — the real call is intercepted by MSW.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-do-not-use";

    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw createError ?? new Error("failed to create test user");
    }
    userId = created.user.id;

    // No discussion-creation endpoint exists yet, so seed directly.
    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Execute route test notebook" })
      .select()
      .single();
    if (notebookError || !notebook) {
      throw notebookError ?? new Error("failed to seed notebook");
    }

    const { data: discussion, error: discussionError } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebook.id,
        user_id: userId,
        name: "Execute route test discussion",
      })
      .select()
      .single();
    if (discussionError || !discussion) {
      throw discussionError ?? new Error("failed to seed discussion");
    }
    discussionId = discussion.id;

    // Unlike the MSW unit-test harness, this file also talks to the real
    // local Supabase instance (auth, PostgREST) — only the Anthropic call
    // is mocked, so unhandled requests must pass through, not error.
    server.listen({ onUnhandledRequest: "bypass" });
  }, 60000);

  beforeEach(() => {
    // The route always requests `stream: true` now, so every test needs
    // the SSE-shaped mock by default; a test that needs something else
    // (e.g. the 409 test's call-tracking override) layers its own
    // server.use() on top, which takes priority for that test.
    server.use(createAnthropicStreamHandler());
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  async function signInAsTestUser(): Promise<CookieRecord[]> {
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

    const { error } = await jarClient.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;

    return cookies;
  }

  test("returns 401 when there is no authenticated user", async () => {
    currentCookies = [];

    const response = await POST(
      makeRequest({ discussionId, promptText: "hello" }),
    );

    expect(response.status).toBe(401);
  });

  test("returns 409 and does not call the model when a lock is already held", async () => {
    currentCookies = await signInAsTestUser();

    const { error: lockError } = await admin
      .from("execution_locks")
      .insert({ user_id: userId, discussion_id: discussionId });
    expect(lockError).toBeNull();

    let modelCalled = false;
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () => {
        modelCalled = true;
        return HttpResponse.json({});
      }),
    );

    const response = await POST(
      makeRequest({ discussionId, promptText: "hello" }),
    );

    expect(response.status).toBe(409);
    expect(modelCalled).toBe(false);

    await admin.from("execution_locks").delete().eq("user_id", userId);
  });

  test("reclaims a stale lock and allows execution to proceed", async () => {
    currentCookies = await signInAsTestUser();

    const { error: lockError } = await admin
      .from("execution_locks")
      .insert({ user_id: userId, discussion_id: discussionId });
    expect(lockError).toBeNull();

    // Backdate the lock past the function's 5-minute staleness threshold,
    // simulating a crashed invocation that never released it.
    const staleAcquiredAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { error: backdateError } = await admin
      .from("execution_locks")
      .update({ acquired_at: staleAcquiredAt })
      .eq("user_id", userId);
    expect(backdateError).toBeNull();

    const promptText = `stale-reclaim-${Date.now()}`;
    const response = await POST(makeRequest({ discussionId, promptText }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.resolved_model).toBe(mockAnthropicStreamedModel);
    expect(body.response).toBe(mockAnthropicStreamedText);

    const { data: lockRows, error: lockCheckError } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);
    expect(lockCheckError).toBeNull();
    expect(lockRows).toHaveLength(0);
  });

  test("returns 500 and touches no lock when ANTHROPIC_API_KEY is not configured", async () => {
    currentCookies = await signInAsTestUser();
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const response = await POST(
        makeRequest({ discussionId, promptText: "hello" }),
      );
      expect(response.status).toBe(500);

      const { data: lockRows, error: lockCheckError } = await admin
        .from("execution_locks")
        .select("*")
        .eq("user_id", userId);
      expect(lockCheckError).toBeNull();
      expect(lockRows).toHaveLength(0);
    } finally {
      process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });

  test("returns 400 for a malformed request body", async () => {
    currentCookies = await signInAsTestUser();

    const response = await POST(
      new Request("http://localhost/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not valid json{{{",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();
  });

  test("returns 400, and never acquires the lock, for an empty or whitespace-only promptText", async () => {
    currentCookies = await signInAsTestUser();

    const response = await POST(
      makeRequest({ discussionId, promptText: "   " }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();

    const { data: lockRows, error: lockCheckError } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);
    expect(lockCheckError).toBeNull();
    expect(lockRows).toHaveLength(0);
  });

  test("on success, inserts a responses row, releases the lock, and never leaks the API key", async () => {
    currentCookies = await signInAsTestUser();

    const promptText = `probe-${Date.now()}`;
    const response = await POST(makeRequest({ discussionId, promptText }));
    const rawText = await response.text();
    const parsed = JSON.parse(rawText);

    expect(response.status).toBe(200);
    expect(parsed.resolved_model).toBe(mockAnthropicStreamedModel);
    expect(parsed.response).toBe(mockAnthropicStreamedText);
    expect(rawText).not.toContain(process.env.ANTHROPIC_API_KEY);

    const { data: responseRows, error: responseError } = await admin
      .from("responses")
      .select("*")
      .eq("discussion_id", discussionId)
      .eq("prompt_text", promptText);

    expect(responseError).toBeNull();
    expect(responseRows).toHaveLength(1);
    expect(responseRows?.[0].resolved_model).toBe(mockAnthropicStreamedModel);
    expect(responseRows?.[0].response).toBe(mockAnthropicStreamedText);

    // Persistence audit finding A: the client needs the real row id to
    // append this run directly into its own in-memory history, instead
    // of only learning about it via a future, unrelated discussion
    // switch's own fetch.
    expect(parsed.response_row_id).toBe(responseRows?.[0].id);

    // Display cleanup: the client shows this timestamp next to
    // "Discussion: {name}" -- must be the row's own database-assigned
    // created_at (set at message_start, near the start of generation),
    // never an approximation of when this request happened to finish.
    expect(parsed.response_created_at).toBe(responseRows?.[0].created_at);

    const { data: lockRows, error: lockError } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);

    expect(lockError).toBeNull();
    expect(lockRows).toHaveLength(0);
  });

  test("streams incrementally: the row exists mid-request with partial content before the final write", async () => {
    currentCookies = await signInAsTestUser();

    // A real per-delta delay, unlike every other test in this file (which
    // uses the default 0ms handler for speed) — this is the one test that
    // actually needs wall-clock time to elapse while the request is still
    // in flight, so there's something to observe mid-stream. A test that
    // only checked the final row state would pass identically whether this
    // was truly streamed or written once at the end; this one doesn't.
    // 400ms/word (11 words ≈ 4.4s total) rather than 200ms/word: task 18
    // raised STREAM_WRITE_THROTTLE_MS 500ms -> 2000ms, so the wait below
    // needs comfortable room past 2000ms for a write to have landed while
    // still leaving the stream clearly unfinished, not a photo finish.
    server.use(createAnthropicStreamHandler(400));

    const promptText = `mid-flight-${Date.now()}`;
    const postPromise = POST(makeRequest({ discussionId, promptText }));

    // message_start arrives near-instantly (the row gets created almost
    // immediately); the throttle (2000ms, task 18) should have let one
    // delta write land by 2500ms in, while the full stream (11 words *
    // 400ms ≈ 4.4s) is still well short of message_stop.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const { data: midFlightRows, error: midFlightError } = await admin
      .from("responses")
      .select("*")
      .eq("discussion_id", discussionId)
      .eq("prompt_text", promptText);

    expect(midFlightError).toBeNull();
    expect(midFlightRows).toHaveLength(1);
    const midFlightRow = midFlightRows![0];

    expect(midFlightRow.resolved_model).toBe(mockAnthropicStreamedModel);
    // The actual proof this is incremental: content already exists, but
    // it's a strict, non-final prefix of the eventual complete text — not
    // null (nothing written yet) and not the full text (written once at
    // the end).
    expect(midFlightRow.response).not.toBeNull();
    expect(midFlightRow.response.length).toBeGreaterThan(0);
    expect(midFlightRow.response).not.toBe(mockAnthropicStreamedText);
    expect(mockAnthropicStreamedText.startsWith(midFlightRow.response)).toBe(
      true,
    );

    const response = await postPromise;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.response).toBe(mockAnthropicStreamedText);

    const { data: finalRows, error: finalError } = await admin
      .from("responses")
      .select("*")
      .eq("discussion_id", discussionId)
      .eq("prompt_text", promptText);

    expect(finalError).toBeNull();
    expect(finalRows).toHaveLength(1);
    // Same row throughout, not a duplicate created at completion.
    expect(finalRows![0].id).toBe(midFlightRow.id);
    expect(finalRows![0].response).toBe(mockAnthropicStreamedText);

    const { data: lockRowsAfter, error: lockErrorAfter } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);
    expect(lockErrorAfter).toBeNull();
    expect(lockRowsAfter).toHaveLength(0);
  });

  test("uses the configured app_settings.max_tokens value, not a hardcoded one", async () => {
    currentCookies = await signInAsTestUser();

    const { error: settingsError } = await admin
      .from("app_settings")
      .update({ max_tokens: 55 })
      .eq("id", 1);
    expect(settingsError).toBeNull();

    let capturedMaxTokens: number | undefined;
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as { max_tokens?: number };
          capturedMaxTokens = body.max_tokens;
          return new HttpResponse(buildTinySseStream("configured"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const promptText = `configured-max-tokens-${Date.now()}`;
    const response = await POST(makeRequest({ discussionId, promptText }));

    expect(response.status).toBe(200);
    expect(capturedMaxTokens).toBe(55);

    await admin.from("app_settings").update({ max_tokens: 40000 }).eq("id", 1);
  });

  test("falls back to the old hardcoded max_tokens when app_settings has no row", async () => {
    currentCookies = await signInAsTestUser();

    const { error: deleteError } = await admin
      .from("app_settings")
      .delete()
      .eq("id", 1);
    expect(deleteError).toBeNull();

    let capturedMaxTokens: number | undefined;
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as { max_tokens?: number };
          capturedMaxTokens = body.max_tokens;
          return new HttpResponse(buildTinySseStream("fallback"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const promptText = `fallback-max-tokens-${Date.now()}`;
    const response = await POST(makeRequest({ discussionId, promptText }));

    expect(response.status).toBe(200);
    expect(capturedMaxTokens).toBe(1000);

    await admin.from("app_settings").insert({ id: 1, max_tokens: 40000 });
  });

  test("logs the real Anthropic error server-side but returns only a generic message to the user", async () => {
    currentCookies = await signInAsTestUser();

    server.use(
      http.post("https://api.anthropic.com/v1/messages", () => {
        return HttpResponse.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          },
          { status: 401 },
        );
      }),
    );

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    let response: Response;
    let body: { error: string; errorId: string };
    let loggedCalls: unknown[][];
    try {
      const promptText = `anthropic-failure-${Date.now()}`;
      response = await POST(makeRequest({ discussionId, promptText }));
      body = await response.json();
    } finally {
      // Captured before restoring -- mockRestore() also clears the
      // recorded call history (same as mockReset()), so inspecting
      // consoleErrorSpy.mock.calls after restoring would always see zero.
      loggedCalls = [...consoleErrorSpy.mock.calls];
      consoleErrorSpy.mockRestore();
    }

    // User-facing: generic, no leaked detail, but a correlation id to
    // match back to the server-side log line.
    expect(response!.status).toBe(500);
    expect(body!.error).toBe(
      "Execution failed. Please try again or contact support if this persists.",
    );
    expect(body!.error).not.toContain("authentication_error");
    expect(body!.error).not.toContain("invalid x-api-key");
    expect(typeof body!.errorId).toBe("string");
    expect(body!.errorId.length).toBeGreaterThan(0);

    // Server-side: the real cause, in full, tagged with that same id.
    expect(loggedCalls.length).toBeGreaterThan(0);
    const loggedText = loggedCalls
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join("\n");
    expect(loggedText).toContain("[execute-error]");
    expect(loggedText).toContain(body!.errorId);
    expect(loggedText).toContain("401");
    expect(loggedText).toContain("authentication_error");
    expect(loggedText).toContain("invalid x-api-key");

    // The lock must still be released despite the failure.
    const { data: lockRows, error: lockCheckError } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);
    expect(lockCheckError).toBeNull();
    expect(lockRows).toHaveLength(0);
  });
});
