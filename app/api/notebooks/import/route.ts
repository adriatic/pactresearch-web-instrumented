import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import {
  validatePactExport,
  PactExportValidationError,
} from "@/lib/pactExport";

async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  let pactExport;
  try {
    pactExport = validatePactExport(rawBody);
  } catch (error) {
    if (error instanceof PactExportValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Fresh ids for every row, minted before any insert -- the same
  // approach pact-mac's importNotebook() uses, and the reason repeated
  // imports of the same file never collide: nothing here reuses an id
  // from the file itself except as a lookup key into these maps.
  const newNotebookId = crypto.randomUUID();
  const discussionIdMap = new Map<string, string>();
  for (const discussion of pactExport.discussions) {
    discussionIdMap.set(discussion.id, crypto.randomUUID());
  }
  const cellIdMap = new Map<string, string>();
  for (const cell of pactExport.cells) {
    cellIdMap.set(cell.id, crypto.randomUUID());
  }

  // PLACEHOLDER BEHAVIOR, not the final intended UX: on a name collision
  // this silently appends the first free number ("My Notebook" -> "My
  // Notebook 1" -> "My Notebook 2"). A future task replaces this with a
  // popup letting the user choose/verify the name interactively before
  // the import completes; this exists so repeated imports of the same
  // file produce distinguishable notebooks instead of a pile of
  // identically-named ones. Collision is checked against the caller's own
  // notebooks only (RLS scopes the select), since names are not globally
  // unique and there is no schema-level constraint behind this.
  const { data: existingNotebooks, error: existingNotebooksError } =
    await supabase.from("notebooks").select("name");
  if (existingNotebooksError) {
    throw existingNotebooksError;
  }

  const takenNames = new Set(
    (existingNotebooks ?? [])
      .map((notebook) => notebook.name)
      .filter((name): name is string => typeof name === "string"),
  );
  let importedNotebookName = pactExport.notebook.name;
  for (let suffix = 1; takenNames.has(importedNotebookName); suffix += 1) {
    importedNotebookName = `${pactExport.notebook.name} ${suffix}`;
  }

  // Persistence audit finding C: a .pact file can legitimately contain
  // two discussions with the same name in one notebook -- most plausibly
  // data exported before the discussions_notebook_id_normalized_name_idx
  // constraint (20260916210914) existed, since the app itself has never
  // allowed creating that state since. Rejecting the whole import
  // outright would block genuinely recoverable older data with no path
  // forward; auto-renaming mirrors exactly how a notebook-name collision
  // is already handled below, for the same reason -- collisions resolve
  // automatically rather than failing the import. Only intra-file
  // collisions are possible here: import always creates a brand-new
  // notebook, so there's nothing already in the database to collide
  // with. Same placeholder-behavior caveat as the notebook-name handling
  // below -- an interactive rename popup is future work, not this fix.
  // Normalized the same way the unique index itself is (trimmed,
  // case-insensitive), so a resolved name here can never collide with
  // that constraint at insert time.
  const takenDiscussionNames = new Set<string>();
  const resolvedDiscussionNames = new Map<string, string>();
  for (const discussion of pactExport.discussions) {
    let resolvedName = discussion.name;
    let normalized = resolvedName.trim().toLowerCase();
    for (let suffix = 1; takenDiscussionNames.has(normalized); suffix += 1) {
      resolvedName = `${discussion.name} ${suffix}`;
      normalized = resolvedName.trim().toLowerCase();
    }
    takenDiscussionNames.add(normalized);
    resolvedDiscussionNames.set(discussion.id, resolvedName);
  }

  // Imported notebooks are never system notebooks, and never carry the
  // original's timestamps -- this is a fresh instance, not a restore.
  const { data: insertedNotebook, error: notebookError } = await supabase
    .from("notebooks")
    .insert({
      id: newNotebookId,
      user_id: user.id,
      name: importedNotebookName,
      system_prompt: pactExport.notebook.systemPrompt,
      category: pactExport.notebook.category,
      is_system: false,
    })
    .select("id, name")
    .single();
  if (notebookError) {
    throw notebookError;
  }

  if (pactExport.discussions.length > 0) {
    const { error: discussionsError } = await supabase
      .from("discussions")
      .insert(
        pactExport.discussions.map((discussion) => ({
          id: discussionIdMap.get(discussion.id),
          notebook_id: newNotebookId,
          user_id: user.id,
          name: resolvedDiscussionNames.get(discussion.id),
          total_time_ms: discussion.totalTimeMs,
          created_at: new Date(discussion.createdAt).toISOString(),
        })),
      );
    if (discussionsError) {
      throw discussionsError;
    }
  }

  if (pactExport.cells.length > 0) {
    const { error: cellsError } = await supabase.from("responses").insert(
      pactExport.cells.map((cell) => ({
        id: cellIdMap.get(cell.id),
        // Validated up front (validatePactExport) to reference a
        // discussion present in this same file, so this lookup can
        // never miss.
        discussion_id: discussionIdMap.get(cell.discussionId),
        // A parentId pointing outside this file (shouldn't happen for a
        // well-formed export, but not guaranteed for a hand-edited one)
        // degrades to no parent rather than failing the whole import.
        parent_id: cell.parentId
          ? (cellIdMap.get(cell.parentId) ?? null)
          : null,
        user_id: user.id,
        prompt_text: cell.promptText,
        response: cell.response,
        model: cell.model,
        resolved_model: cell.resolvedModel ?? null,
        cell_type: cell.cellType,
        created_at: new Date(cell.createdAt).toISOString(),
      })),
    );
    if (cellsError) {
      throw cellsError;
    }
  }

  return Response.json(insertedNotebook, { status: 201 });
}

export const POST = withRouteErrorHandling(handlePost);
