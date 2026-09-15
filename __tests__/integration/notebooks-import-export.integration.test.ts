import { beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Proves the .pact export/import round trip does what it exists for:
// export a notebook, import the file back, get a fully independent,
// content-identical notebook -- every id fresh, nothing colliding with
// the original or with a second import of the exact same file.

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

let currentCookies: CookieRecord[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => currentCookies,
    get: (name: string) => currentCookies.find((c) => c.name === name),
    set: () => {},
  }),
}));

const { GET: exportGet } = await import("@/app/api/notebooks/export/route");
const { POST: importPost } = await import("@/app/api/notebooks/import/route");

function makeExportRequest(notebookId: string) {
  return new Request(`http://localhost/api/notebooks/export?id=${notebookId}`);
}

function makeImportRequest(body: unknown) {
  return new Request("http://localhost/api/notebooks/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/notebooks/export + POST /api/notebooks/import", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebooks, " +
        "public.discussions, public.responses, public.execution_locks " +
        "TO anon, authenticated, service_role;",
    );

    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;

    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;

    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
  }, 60000);

  async function createSignedInUser(): Promise<{
    userId: string;
    cookies: CookieRecord[];
  }> {
    const email = `pact-import-export-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 7!";

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

  // Seeds a notebook with 2 discussions and several cells, including a
  // parent_id chain within one discussion and one cell with a null
  // response (an in-progress/failed execution), directly via the service
  // client -- the same seeding pattern used throughout this test suite.
  async function seedSourceNotebook(userId: string) {
    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({
        user_id: userId,
        name: "Export source notebook",
        system_prompt: "Be concise.",
        category: "Dev Test",
      })
      .select()
      .single();
    if (notebookError || !notebook) throw notebookError;

    const { data: discussionA, error: discussionAError } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebook.id,
        user_id: userId,
        name: "Discussion A",
        total_time_ms: 4200,
      })
      .select()
      .single();
    if (discussionAError || !discussionA) throw discussionAError;

    const { data: discussionB, error: discussionBError } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebook.id,
        user_id: userId,
        name: "Discussion B",
        total_time_ms: 0,
      })
      .select()
      .single();
    if (discussionBError || !discussionB) throw discussionBError;

    const { data: cellA1, error: cellA1Error } = await admin
      .from("responses")
      .insert({
        discussion_id: discussionA.id,
        user_id: userId,
        prompt_text: "First prompt in A",
        response: "First response in A",
        model: "claude-sonnet-4-6",
        resolved_model: "claude-sonnet-4-6-20260101",
        cell_type: "assistant",
      })
      .select()
      .single();
    if (cellA1Error || !cellA1) throw cellA1Error;

    // Child of cellA1 -- the parent_id chain export/import must preserve
    // by remapping to the new cell ids, not the old ones.
    const { error: cellA2Error } = await admin.from("responses").insert({
      discussion_id: discussionA.id,
      parent_id: cellA1.id,
      user_id: userId,
      prompt_text: "Follow-up prompt in A",
      response: "Follow-up response in A",
      model: "claude-sonnet-4-6",
      cell_type: "assistant",
    });
    if (cellA2Error) throw cellA2Error;

    // Null response -- an in-progress/failed execution. Export must
    // coerce this to "" (pact-mac's cell type is non-nullable) without
    // crashing.
    const { error: cellBError } = await admin.from("responses").insert({
      discussion_id: discussionB.id,
      user_id: userId,
      prompt_text: "Prompt in B, never completed",
      response: null,
      model: "claude-sonnet-4-6",
      cell_type: "assistant",
    });
    if (cellBError) throw cellBError;

    return { notebookId: notebook.id as string };
  }

  test("export produces the documented shape, coercing a null response to an empty string", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;
    const { notebookId } = await seedSourceNotebook(userId);

    const response = await exportGet(makeExportRequest(notebookId));
    expect(response.status).toBe(200);
    const pactExport = await response.json();

    expect(pactExport.version).toBe(1);
    expect(typeof pactExport.exportedAt).toBe("number");
    expect(pactExport.notebook).toMatchObject({
      name: "Export source notebook",
      systemPrompt: "Be concise.",
      category: "Dev Test",
    });
    expect(pactExport.discussions).toHaveLength(2);
    expect(pactExport.cells).toHaveLength(3);

    const nullResponseCell = pactExport.cells.find(
      (c: { promptText: string }) =>
        c.promptText === "Prompt in B, never completed",
    );
    expect(nullResponseCell.response).toBe("");
  });

  test("importing an exported file creates an independent notebook with fresh, non-colliding ids and correctly remapped references", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;
    const { notebookId: sourceNotebookId } = await seedSourceNotebook(userId);

    const exportResponse = await exportGet(makeExportRequest(sourceNotebookId));
    const pactExport = await exportResponse.json();

    const importResponse = await importPost(makeImportRequest(pactExport));
    expect(importResponse.status).toBe(201);
    const importedNotebook = await importResponse.json();
    expect(importedNotebook.id).not.toBe(sourceNotebookId);
    expect(importedNotebook.name).toBe("Export source notebook");

    const { data: importedDiscussions, error: discussionsError } = await admin
      .from("discussions")
      .select("*")
      .eq("notebook_id", importedNotebook.id)
      .order("name");
    expect(discussionsError).toBeNull();
    expect(importedDiscussions).toHaveLength(2);

    const originalDiscussionIds = new Set(
      pactExport.discussions.map((d: { id: string }) => d.id),
    );
    for (const discussion of importedDiscussions!) {
      expect(originalDiscussionIds.has(discussion.id)).toBe(false);
      expect(discussion.user_id).toBe(userId);
    }
    const newDiscussionA = importedDiscussions!.find(
      (d) => d.name === "Discussion A",
    );
    const newDiscussionB = importedDiscussions!.find(
      (d) => d.name === "Discussion B",
    );
    expect(newDiscussionA.total_time_ms).toBe(4200);
    expect(newDiscussionB.total_time_ms).toBe(0);

    const { data: importedCells, error: cellsError } = await admin
      .from("responses")
      .select("*")
      .in("discussion_id", [newDiscussionA.id, newDiscussionB.id])
      .order("created_at");
    expect(cellsError).toBeNull();
    expect(importedCells).toHaveLength(3);

    const originalCellIds = new Set(
      pactExport.cells.map((c: { id: string }) => c.id),
    );
    for (const cell of importedCells!) {
      expect(originalCellIds.has(cell.id)).toBe(false);
      expect(cell.user_id).toBe(userId);
    }

    // The parent_id chain must point at the NEW cell id, not the
    // original -- this is the actual point of the id-remapping table.
    const newCellA1 = importedCells!.find(
      (c) => c.prompt_text === "First prompt in A",
    );
    const newCellA2 = importedCells!.find(
      (c) => c.prompt_text === "Follow-up prompt in A",
    );
    expect(newCellA1.discussion_id).toBe(newDiscussionA.id);
    expect(newCellA2.parent_id).toBe(newCellA1.id);

    const newCellB = importedCells!.find(
      (c) => c.prompt_text === "Prompt in B, never completed",
    );
    expect(newCellB.discussion_id).toBe(newDiscussionB.id);
    // Exported as "" (coerced from null); import stores it back as "".
    expect(newCellB.response).toBe("");
  });

  test("importing the same file twice produces two more independent notebooks, never colliding", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;
    const { notebookId: sourceNotebookId } = await seedSourceNotebook(userId);
    const exportResponse = await exportGet(makeExportRequest(sourceNotebookId));
    const pactExport = await exportResponse.json();

    const firstImport = await importPost(makeImportRequest(pactExport));
    const firstNotebook = await firstImport.json();
    const secondImport = await importPost(makeImportRequest(pactExport));
    const secondNotebook = await secondImport.json();

    expect(firstImport.status).toBe(201);
    expect(secondImport.status).toBe(201);
    expect(firstNotebook.id).not.toBe(secondNotebook.id);
    expect(firstNotebook.id).not.toBe(sourceNotebookId);
    expect(secondNotebook.id).not.toBe(sourceNotebookId);

    for (const notebookId of [
      sourceNotebookId,
      firstNotebook.id,
      secondNotebook.id,
    ]) {
      const { data: rows, error } = await admin
        .from("discussions")
        .select("id")
        .eq("notebook_id", notebookId);
      expect(error).toBeNull();
      expect(rows).toHaveLength(2);
    }

    // Three fully independent notebooks now exist for this user with the
    // same content -- exactly the repeatability property this feature
    // exists for.
    const { data: allNotebooks, error: allError } = await admin
      .from("notebooks")
      .select("id")
      .eq("user_id", userId)
      .eq("name", "Export source notebook");
    expect(allError).toBeNull();
    expect(allNotebooks).toHaveLength(3);
  });

  test("importing under a different account assigns the new notebook to that account, not the original owner", async () => {
    const owner = await createSignedInUser();
    currentCookies = owner.cookies;
    const { notebookId: sourceNotebookId } = await seedSourceNotebook(
      owner.userId,
    );
    const exportResponse = await exportGet(makeExportRequest(sourceNotebookId));
    const pactExport = await exportResponse.json();

    const importer = await createSignedInUser();
    currentCookies = importer.cookies;
    const importResponse = await importPost(makeImportRequest(pactExport));
    expect(importResponse.status).toBe(201);
    const importedNotebook = await importResponse.json();

    const { data: notebookRow, error } = await admin
      .from("notebooks")
      .select("user_id")
      .eq("id", importedNotebook.id)
      .single();
    expect(error).toBeNull();
    expect(notebookRow!.user_id).toBe(importer.userId);
    expect(notebookRow!.user_id).not.toBe(owner.userId);
  });

  test("rejects a malformed .pact file with a clear error instead of crashing", async () => {
    const { cookies } = await createSignedInUser();
    currentCookies = cookies;

    const notEvenAnObject = await importPost(
      makeImportRequest("just a string"),
    );
    expect(notEvenAnObject.status).toBe(400);
    expect((await notEvenAnObject.json()).error).toBeTruthy();

    const wrongVersion = await importPost(
      makeImportRequest({
        version: 999,
        notebook: { name: "x" },
        discussions: [],
        cells: [],
      }),
    );
    expect(wrongVersion.status).toBe(400);
    expect((await wrongVersion.json()).error).toMatch(/version/i);

    const missingNotebookName = await importPost(
      makeImportRequest({
        version: 1,
        notebook: {},
        discussions: [],
        cells: [],
      }),
    );
    expect(missingNotebookName.status).toBe(400);

    const cellReferencesUnknownDiscussion = await importPost(
      makeImportRequest({
        version: 1,
        notebook: { name: "x", systemPrompt: null },
        discussions: [
          { id: "d1", name: "D1", createdAt: Date.now(), totalTimeMs: 0 },
        ],
        cells: [
          {
            id: "c1",
            discussionId: "does-not-exist",
            parentId: null,
            promptText: "p",
            response: "r",
            model: "m",
            cellType: "assistant",
            createdAt: Date.now(),
          },
        ],
      }),
    );
    expect(cellReferencesUnknownDiscussion.status).toBe(400);
  });
});
