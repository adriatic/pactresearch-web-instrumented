"use client";

import { useRef, useState } from "react";

// Minimal admin-only control for the single global app_settings row.
// Deliberately just a form -- no elaborate settings page -- gated by the
// server component that renders this (app/admin/page.tsx) checking
// isAdmin() before ever sending this component to the client; the API
// route this posts to re-checks isAdmin() itself, and RLS is the actual
// enforcement underneath both.
export function AdminSettingsForm({
  initialMaxTokens,
}: {
  initialMaxTokens: number;
}) {
  const [maxTokens, setMaxTokens] = useState(String(initialMaxTokens));
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxTokens: Number(maxTokens) }),
      });
      const body = await response.json();
      if (response.ok) {
        setMessage(`Saved -- max_tokens is now ${body.max_tokens}.`);
      } else {
        setMessage(body.error || "Failed to update the setting.");
      }
    } catch {
      setMessage("Failed to update the setting -- please try again.");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }

  return (
    <section>
      <h1>Admin settings</h1>
      <form onSubmit={handleSubmit}>
        <label>
          max_tokens (per /api/execute run):{" "}
          <input
            type="number"
            min={1}
            step={1}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            required
          />
        </label>
        <br />
        <button type="submit" disabled={loading}>
          {loading ? "Saving..." : "Save"}
        </button>
      </form>
      {message && <p>{message}</p>}
    </section>
  );
}
