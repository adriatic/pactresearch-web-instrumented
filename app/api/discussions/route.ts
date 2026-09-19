import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("pact-api");

interface CreateDiscussionRequestBody {
  notebookId: string;
  name: string;
}

async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let notebookId: string;
  let name: string;
  try {
    const body = (await request.json()) as CreateDiscussionRequestBody;
    notebookId = body.notebookId;
    name = body.name;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  if (typeof notebookId !== "string" || notebookId.trim().length === 0) {
    return Response.json(
      { error: "notebookId is required and must be a non-empty string." },
      { status: 400 },
    );
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return Response.json(
      { error: "name is required and must be a non-empty string." },
      { status: 400 },
    );
  }

  // Session-scoped client: RLS ("Users manage their own notebooks")
  // restricts this to notebooks the caller owns, so a notebookId belonging
  // to another user is indistinguishable here from one that doesn't exist
  // at all — both are just "not found" from this caller's perspective.
  const { data: notebook, error: notebookError } = await supabase
    .from("notebooks")
    .select("id")
    .eq("id", notebookId)
    .maybeSingle();

  if (notebookError) {
    throw notebookError;
  }

  if (!notebook) {
    return Response.json({ error: "Notebook not found." }, { status: 404 });
  }

  const { data: discussion, error: insertError } = await supabase
    .from("discussions")
    .insert({ notebook_id: notebookId, user_id: user.id, name })
    .select()
    .single();

  if (insertError) {
    // 23505 = unique_violation, from discussions_notebook_id_normalized_
    // name_idx (see 20260916210914) -- this is the authoritative,
    // race-proof enforcement of the same rule NotebookCreator's own
    // client-side check applies optimistically before ever reaching this
    // route. That earlier check is real UX (instant feedback, no round
    // trip through a failed create), but it reads and decides in two
    // separate steps with nothing atomic tying them together, so it
    // can't be the actual source of truth -- two near-simultaneous
    // requests (two tabs, or a fast double-submit) could both pass it.
    // This is what makes the rule actually hold.
    if (insertError.code === "23505") {
      return Response.json(
        {
          error: `This notebook already has a discussion named "${name.trim()}". Pick a different name.`,
        },
        { status: 409 },
      );
    }
    throw insertError;
  }

  return Response.json(discussion, { status: 201 });
}

async function handleGet(request: Request) {
  const supabase = await createClient();
  const user = await tracer.startActiveSpan("auth", async (span) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user;
    } finally {
      span.end();
    }
  });

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Session-scoped client + RLS: this already returns only the caller's
  // own discussions, same reliance on RLS as the notebook-ownership check
  // above — no separate `user_id` filter needed here either. The embedded
  // notebooks(name) is scoped by the same RLS policy on notebooks, so this
  // can only ever resolve to a notebook the caller themselves owns.
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  trace.getActiveSpan()?.setAttribute("pact.discussion_id", id ?? "all");

  let query = supabase
    .from("discussions")
    .select("*, notebooks(name)")
    .order("created_at", { ascending: false });

  // Optional narrowing to a single discussion (e.g. ExecuteTester loading
  // one discussion's persisted draft) — still a "list" response shape
  // (an array, possibly empty or single-item), just filtered server-side
  // instead of client-side.
  if (id) {
    query = query.eq("id", id);
  }

  const { data: discussions, error } = await tracer.startActiveSpan(
    "discussions-select",
    async (span) => {
      try {
        return await query;
      } finally {
        span.end();
      }
    },
  );

  if (error) {
    throw error;
  }

  return Response.json(discussions);
}

interface UpdateDiscussionRequestBody {
  draftPromptText: string | null;
}

async function handlePatch(request: Request) {
  const supabase = await createClient();
  const user = await tracer.startActiveSpan("auth", async (span) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user;
    } finally {
      span.end();
    }
  });

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return Response.json({ error: "id is required." }, { status: 400 });
  }
  trace.getActiveSpan()?.setAttribute("pact.discussion_id", id);

  let draftPromptText: string | null;
  try {
    const body = (await request.json()) as UpdateDiscussionRequestBody;
    draftPromptText = body.draftPromptText;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  if (draftPromptText !== null && typeof draftPromptText !== "string") {
    return Response.json(
      { error: "draftPromptText must be a string or null." },
      { status: 400 },
    );
  }

  // Session-scoped client + RLS: this can only ever update a discussion
  // the caller owns — an empty result covers both "doesn't exist" and
  // "isn't yours", same non-distinguishing 404 pattern as DELETE
  // /api/notebooks.
  const { data: updated, error } = await tracer.startActiveSpan(
    "discussions-update",
    async (span) => {
      try {
        return await supabase
          .from("discussions")
          .update({ draft_prompt_text: draftPromptText })
          .eq("id", id)
          .select();
      } finally {
        span.end();
      }
    },
  );

  if (error) {
    throw error;
  }

  if (updated.length === 0) {
    return Response.json({ error: "Discussion not found." }, { status: 404 });
  }

  return Response.json(updated[0]);
}

async function handleDelete(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return Response.json({ error: "id is required." }, { status: 400 });
  }

  // Same protection DELETE /api/notebooks already applies, scoped to this
  // one discussion: refuse while its own execution lock is genuinely
  // active (non-stale), so an in-flight Anthropic call can't keep writing
  // responses rows against a discussion that no longer exists. Note this
  // is unrelated to the notebook-level check — that one blocks deleting a
  // *notebook* because some discussion inside it is executing; deleting a
  // discussion is never blocked by a sibling discussion's lock.
  const { data: hasActiveLock, error: lockCheckError } = await supabase.rpc(
    "discussion_has_active_execution_lock",
    { p_discussion_id: id },
  );

  if (lockCheckError) {
    throw lockCheckError;
  }

  if (hasActiveLock) {
    return Response.json(
      {
        error: "Cannot delete this discussion while it is actively executing.",
      },
      { status: 409 },
    );
  }

  // Session-scoped client + RLS: this can only ever delete a discussion
  // the caller owns. An empty result covers both "doesn't exist" and
  // "isn't yours" — same non-distinguishing 404 pattern as DELETE
  // /api/notebooks. Child rows (responses, execution_locks) cascade via
  // their own ON DELETE CASCADE.
  const { data: deleted, error } = await supabase
    .from("discussions")
    .delete()
    .eq("id", id)
    .select();

  if (error) {
    throw error;
  }

  if (deleted.length === 0) {
    return Response.json({ error: "Discussion not found." }, { status: 404 });
  }

  return Response.json(deleted[0]);
}

export const POST = withRouteErrorHandling(handlePost);
export const DELETE = withRouteErrorHandling(handleDelete);
export const GET = withRouteErrorHandling(handleGet);
export const PATCH = withRouteErrorHandling(handlePatch);
