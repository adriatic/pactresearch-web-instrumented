import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { isAdmin } from "@/lib/isAdmin";

// Same gating shape as app/admin/page.tsx: redirect unauthenticated
// visitors to /login, render a plain "Not authorized." for an
// authenticated non-admin. isAdmin() is defense-in-depth here, same as
// everywhere else it's used -- the real enforcement is the
// "Admins can read all execution timings" RLS policy on the query below,
// which is what actually makes a non-admin's own session unable to see
// other users' rows regardless of what this page's own check does.
const PAGE_SIZE = 50;

interface ExecutionTimingRow {
  id: string;
  created_at: string;
  discussion_id: string | null;
  resolved_model: string | null;
  max_tokens: number | null;
  auth_ms: number | null;
  lock_acquire_ms: number | null;
  settings_read_ms: number | null;
  anthropic_connect_ms: number | null;
  message_start_insert_ms: number | null;
  time_to_first_token_ms: number | null;
  generation_ms: number | null;
  throttled_write_count: number | null;
  throttled_write_total_ms: number | null;
  final_write_ms: number | null;
  lock_release_ms: number | null;
  total_ms: number | null;
}

function numbers(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ms values run from single digits (auth) to hundreds of thousands
// (total, on a long generation) -- switching to seconds above 1000ms
// keeps the table and stats readable at both ends rather than printing
// "157601ms" next to "234ms".
function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export default async function TimingsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
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

  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // { count: "exact" } gets Postgres to compute the row count as part of
  // this same query (via PostgREST's Prefer: count=exact) rather than a
  // second round trip -- still cheap: it's a count, not a fetch of every
  // row's data, so pagination stays correct without ever loading the
  // whole table into the app.
  const {
    data: rows,
    error,
    count,
  } = await supabase
    .from("execution_timings")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    throw error;
  }

  const typedRows = (rows ?? []) as ExecutionTimingRow[];
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Aggregates are computed from this page's rows only, not a separate
  // full-table query -- exactly what's already been paid for above, no
  // additional cost as the table grows. Labeled below as "shown rows",
  // not "all time", so that's not ambiguous to whoever's reading this.
  const totalMsValues = numbers(typedRows.map((r) => r.total_ms));
  const ttftValues = numbers(typedRows.map((r) => r.time_to_first_token_ms));
  const writeCountValues = numbers(
    typedRows.map((r) => r.throttled_write_count),
  );

  return (
    <section>
      <h1>Execution timings</h1>
      <p>
        {totalCount} execution{totalCount === 1 ? "" : "s"} recorded.
        {totalPages > 1
          ? ` Showing ${from + 1}–${Math.min(to + 1, totalCount)}.`
          : ""}
      </p>

      {typedRows.length === 0 ? (
        <p>No executions recorded yet.</p>
      ) : (
        <>
          <h2>At a glance (shown rows)</h2>
          <ul>
            <li>Average total: {fmtMs(average(totalMsValues))}</li>
            <li>Median total: {fmtMs(median(totalMsValues))}</li>
            <li>Average time-to-first-token: {fmtMs(average(ttftValues))}</li>
            <li>
              Average throttled-write count:{" "}
              {writeCountValues.length > 0
                ? average(writeCountValues)!.toFixed(1)
                : "—"}
            </li>
          </ul>

          <h2>Recent executions</h2>
          <table border={1} cellPadding={4}>
            <thead>
              <tr>
                <th>Created</th>
                <th>Discussion</th>
                <th>Model</th>
                <th>Auth</th>
                <th>Lock</th>
                <th>Settings</th>
                <th>TTFT</th>
                <th>Generation</th>
                <th>Writes</th>
                <th>Final write</th>
                <th>Lock release</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {typedRows.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td>
                    {row.discussion_id
                      ? `${row.discussion_id.slice(0, 8)}…`
                      : "—"}
                  </td>
                  <td>{row.resolved_model ?? "—"}</td>
                  <td>{fmtMs(row.auth_ms)}</td>
                  <td>{fmtMs(row.lock_acquire_ms)}</td>
                  <td>{fmtMs(row.settings_read_ms)}</td>
                  <td>{fmtMs(row.time_to_first_token_ms)}</td>
                  <td>{fmtMs(row.generation_ms)}</td>
                  <td>
                    {row.throttled_write_count ?? "—"}
                    {row.throttled_write_count
                      ? ` (${fmtMs(row.throttled_write_total_ms)})`
                      : ""}
                  </td>
                  <td>{fmtMs(row.final_write_ms)}</td>
                  <td>{fmtMs(row.lock_release_ms)}</td>
                  <td>{fmtMs(row.total_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <p>
              Page {page} of {totalPages} —{" "}
              {page > 1 && (
                <Link href={`/admin/timings?page=${page - 1}`}>Previous</Link>
              )}
              {page > 1 && page < totalPages ? " · " : ""}
              {page < totalPages && (
                <Link href={`/admin/timings?page=${page + 1}`}>Next</Link>
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
