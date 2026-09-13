import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { isAdmin } from "@/lib/isAdmin";

interface UpdateSettingsRequestBody {
  maxTokens: number;
}

async function handleGet() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(supabase, user.id))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: settings, error } = await supabase
    .from("app_settings")
    .select("max_tokens")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!settings) {
    return Response.json(
      { error: "app_settings row not found." },
      { status: 404 },
    );
  }

  return Response.json(settings);
}

async function handlePatch(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(supabase, user.id))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let maxTokens: number;
  try {
    const body = (await request.json()) as UpdateSettingsRequestBody;
    maxTokens = body.maxTokens;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    return Response.json(
      { error: "maxTokens must be a positive integer." },
      { status: 400 },
    );
  }

  // RLS ("Only admins can update app settings") is the actual
  // enforcement here -- the isAdmin() check above is a defense-in-depth
  // early-exit, not the source of truth.
  const { data: updated, error } = await supabase
    .from("app_settings")
    .update({ max_tokens: maxTokens, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select("max_tokens")
    .single();

  if (error) {
    throw error;
  }

  return Response.json(updated);
}

export const GET = withRouteErrorHandling(handleGet);
export const PATCH = withRouteErrorHandling(handlePatch);
