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

  // Imported notebooks are never system notebooks, and never carry the
  // original's timestamps -- this is a fresh instance, not a restore.
  const { data: insertedNotebook, error: notebookError } = await supabase
    .from("notebooks")
    .insert({
      id: newNotebookId,
      user_id: user.id,
      name: pactExport.notebook.name,
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
          name: discussion.name,
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
