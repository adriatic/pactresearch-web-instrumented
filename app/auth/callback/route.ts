import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // TEMPORARY diagnostic -- not part of production's callback route.
  // Surfacing what actually happens here to debug why the magic-link
  // flow loops back to /login on the instrumented deployment. Remove
  // once diagnosed.
  console.log(
    `[auth-callback-debug] url=${request.url} hasCode=${Boolean(code)} params=${searchParams.toString()}`,
  );

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    console.log(
      `[auth-callback-debug] exchangeCodeForSession error=${error ? JSON.stringify({ message: error.message, status: error.status, code: error.code }) : "none"}`,
    );
  }

  return NextResponse.redirect(`${origin}/`);
}
