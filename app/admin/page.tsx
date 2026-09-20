import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { isAdmin } from "@/lib/isAdmin";
import { AdminSettingsForm } from "../AdminSettingsForm";

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  if (!(await isAdmin(supabase, user.id))) {
    return <p>Not authorized.</p>;
  }

  const { data: settings, error } = await supabase
    .from("app_settings")
    .select("max_tokens")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (
    <>
      <AdminSettingsForm initialMaxTokens={settings?.max_tokens ?? 40000} />
      <p>
        <Link href="/admin/timings">Execution timings</Link>
      </p>
    </>
  );
}
