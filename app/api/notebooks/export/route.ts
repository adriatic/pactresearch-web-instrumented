import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import {
  PACT_EXPORT_VERSION,
  type PactExport,
  type PactExportCell,
  type PactExportDiscussion,
} from "@/lib/pactExport";

async function handleGet(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const notebookId = searchParams.get("id");
  if (!notebookId) {
    return Response.json({ error: "id is required." }, { status: 400 });
  }

  // Session-scoped client + RLS: this can only ever find a notebook the
  // caller owns, same non-distinguishing 404 pattern as DELETE
  // /api/notebooks.
  const { data: notebook, error: notebookError } = await supabase
    .from("notebooks")
    .select("name, system_prompt, category")
    .eq("id", notebookId)
    .maybeSingle();
  if (notebookError) {
    throw notebookError;
  }
  if (!notebook) {
    return Response.json({ error: "Notebook not found." }, { status: 404 });
  }

  const { data: discussionRows, error: discussionsError } = await supabase
    .from("discussions")
    .select("id, name, created_at, total_time_ms")
    .eq("notebook_id", notebookId);
  if (discussionsError) {
    throw discussionsError;
  }

  const discussionIds = discussionRows.map((d) => d.id);
  const { data: responseRows, error: responsesError } =
    discussionIds.length > 0
      ? await supabase
          .from("responses")
          .select(
            "id, discussion_id, parent_id, prompt_text, response, model, resolved_model, cell_type, created_at",
          )
          .in("discussion_id", discussionIds)
      : { data: [], error: null };
  if (responsesError) {
    throw responsesError;
  }

  const discussions: PactExportDiscussion[] = discussionRows.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: new Date(d.created_at).getTime(),
    totalTimeMs: d.total_time_ms,
  }));

  // response is nullable in this app (an in-progress or failed execution
  // can leave it null) but pact-mac's cell type declares it as a
  // non-nullable string -- coerced to "" to keep the file shape honest
  // to that type without crashing on real in-progress data.
  const cells: PactExportCell[] = responseRows.map((r) => ({
    id: r.id,
    discussionId: r.discussion_id,
    parentId: r.parent_id,
    promptText: r.prompt_text,
    response: r.response ?? "",
    model: r.model,
    resolvedModel: r.resolved_model,
    cellType: r.cell_type,
    createdAt: new Date(r.created_at).getTime(),
  }));

  const pactExport: PactExport = {
    version: PACT_EXPORT_VERSION,
    exportedAt: Date.now(),
    notebook: {
      name: notebook.name,
      systemPrompt: notebook.system_prompt,
      category: notebook.category,
    },
    discussions,
    cells,
  };

  return Response.json(pactExport);
}

export const GET = withRouteErrorHandling(handleGet);
