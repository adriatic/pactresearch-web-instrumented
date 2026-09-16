import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { withFullTiming, type HandlerTimer } from "@/lib/timing";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

// Used only if app_settings can't be read for some reason (empty table,
// query error) -- the previous hardcoded value, so a settings-table
// outage degrades to the old behavior rather than failing every run.
const FALLBACK_MAX_TOKENS = 1000;

// Minimum time between UPDATEs to the responses row while content streams
// in. Anthropic's content_block_delta events can arrive many times a
// second — writing to Postgres on every single one would be wasteful and
// buys nothing, since no human (or Realtime-subscribed UI) can perceive
// updates faster than this anyway. 500ms is chosen the same way the
// execution_locks staleness threshold was: long enough to keep write
// volume reasonable even for a long, fast-streaming response (a ~10s
// generation lands around 20 writes, not hundreds), short enough that a
// Realtime subscriber watching the row still sees it grow live, well
// under the threshold of feeling laggy.
const STREAM_WRITE_THROTTLE_MS = 500;

interface ExecuteRequestBody {
  discussionId: string;
  promptText: string;
}

async function handlePost(timer: HandlerTimer, request: Request) {
  const supabase = await createClient();
  const authStart = performance.now();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  timer.mark("auth", performance.now() - authStart);

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not configured" },
      { status: 500 },
    );
  }

  let discussionId: string;
  let promptText: string;
  try {
    const body = (await request.json()) as ExecuteRequestBody;
    discussionId = body.discussionId;
    promptText = body.promptText;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }
  timer.setLabel(`POST /api/execute discussionId=${discussionId}`);

  if (typeof promptText !== "string" || promptText.trim().length === 0) {
    return Response.json(
      { error: "promptText is required and must be a non-empty string." },
      { status: 400 },
    );
  }

  const lockAcquireStart = performance.now();
  const { data: acquired, error: lockError } = await supabase.rpc(
    "try_acquire_execution_lock",
    { p_user_id: user.id, p_discussion_id: discussionId },
  );
  timer.mark("lock-acquire", performance.now() - lockAcquireStart);

  if (lockError) {
    throw lockError;
  }

  if (!acquired) {
    return Response.json(
      { error: "An execution is already in progress for this user." },
      { status: 409 },
    );
  }

  try {
    // Global, admin-configurable cap (see app_settings / 20260913035840)
    // -- replaces the old hardcoded max_tokens: 1000, which is exactly
    // what caused the truncated long responses found in the earlier
    // timing investigation. A missing/unreadable settings row falls back
    // to that same old value rather than failing the run.
    const settingsReadStart = performance.now();
    let maxTokens = FALLBACK_MAX_TOKENS;
    const { data: settings, error: settingsError } = await supabase
      .from("app_settings")
      .select("max_tokens")
      .eq("id", 1)
      .maybeSingle();
    timer.mark("settings-read", performance.now() - settingsReadStart);

    if (settingsError || !settings) {
      console.error(
        `[app-settings-fallback] Could not read app_settings (id=1) -- falling back to max_tokens=${FALLBACK_MAX_TOKENS}.`,
        settingsError ?? "no row found",
      );
    } else {
      maxTokens = settings.max_tokens;
    }

    // Investigation-only timing (kept permanently, same call as the
    // discussion-switch instrumentation: cheap, and this is the app's
    // actual core operation). anthropicFetchStart is the reference point
    // for both "time to establish the connection" (this await resolving —
    // stream:true means it resolves once headers arrive, not the full
    // body) and "time to first token" (first real text_delta), measured
    // separately below.
    const anthropicFetchStart = performance.now();
    const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: "user", content: promptText }],
      }),
    });
    timer.mark("anthropic-connect", performance.now() - anthropicFetchStart);

    if (!anthropicResponse.ok || !anthropicResponse.body) {
      // Anthropic's error responses are a JSON body describing exactly what
      // went wrong (bad/expired key, invalid_request_error for a bad
      // param, rate limit, etc.) -- read it now, while the response is
      // still available, so the real cause ends up in the thrown error's
      // own message rather than just a bare status code. Whatever this
      // throws is what the catch block below logs in full.
      const errorBody = await anthropicResponse
        .text()
        .catch(() => "<failed to read response body>");
      throw new Error(
        `Anthropic API request failed with status ${anthropicResponse.status}: ${errorBody}`,
      );
    }

    let resolvedModel: string | null = null;
    let accumulatedText = "";
    let responseRowId: string | null = null;
    let responseCreatedAt: string | null = null;
    // Seeded to "now" rather than 0, so the throttle genuinely applies to
    // the first delta too — otherwise Date.now() - 0 is always well past
    // the threshold and the very first delta bypasses it.
    let lastWriteAt = Date.now();
    let lastWrittenText = "";

    // Streaming-phase timing state — first token marks the end of TTFB
    // and the start of "generation"; the write counters give a cheap
    // aggregate view of the throttled-UPDATE cost without logging every
    // single one individually (which would be excessive for a response
    // that can throttle-write dozens of times).
    let firstTokenAt: number | null = null;
    let streamingWriteCount = 0;
    let streamingWriteTotalMs = 0;

    const reader = anthropicResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line; the last (possibly
      // incomplete) chunk stays in the buffer for the next read.
      const rawEvents = buffer.split("\n\n");
      buffer = rawEvents.pop() ?? "";

      for (const rawEvent of rawEvents) {
        const dataLine = rawEvent
          .split("\n")
          .find((line) => line.startsWith("data:"));
        if (!dataLine) continue;

        const jsonText = dataLine.slice("data:".length).trim();
        if (!jsonText) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(jsonText) as Record<string, unknown>;
        } catch {
          continue;
        }

        switch (event.type) {
          case "message_start": {
            const message = event.message as { model?: string } | undefined;
            resolvedModel = message?.model ?? null;

            // The row a Realtime subscriber would attach to — created as
            // soon as we know the resolved model, before any content has
            // arrived.
            const messageStartInsertStart = performance.now();
            const { data: inserted, error: insertError } = await supabase
              .from("responses")
              .insert({
                discussion_id: discussionId,
                user_id: user.id,
                prompt_text: promptText,
                response: null,
                model: ANTHROPIC_MODEL,
                resolved_model: resolvedModel,
                cell_type: "assistant",
              })
              .select("id, created_at")
              .single();
            timer.mark(
              "message-start-insert",
              performance.now() - messageStartInsertStart,
            );

            if (insertError) {
              throw insertError;
            }
            responseRowId = inserted.id as string;
            responseCreatedAt = inserted.created_at as string;
            break;
          }

          case "content_block_delta": {
            const delta = event.delta as
              { type?: string; text?: string } | undefined;
            if (delta?.type === "text_delta" && delta.text) {
              if (firstTokenAt === null) {
                firstTokenAt = performance.now();
                timer.mark("ttfb", firstTokenAt - anthropicFetchStart);
              }
              accumulatedText += delta.text;
            }

            const now = Date.now();
            if (
              responseRowId &&
              accumulatedText !== lastWrittenText &&
              now - lastWriteAt >= STREAM_WRITE_THROTTLE_MS
            ) {
              const writeStart = performance.now();
              const { error: updateError } = await supabase
                .from("responses")
                .update({ response: accumulatedText })
                .eq("id", responseRowId);
              streamingWriteCount += 1;
              streamingWriteTotalMs += performance.now() - writeStart;

              if (updateError) {
                throw updateError;
              }
              lastWriteAt = now;
              lastWrittenText = accumulatedText;
            }
            break;
          }

          case "message_stop": {
            // Generation is measured from the first real token, not from
            // the Anthropic connect — TTFB and generation are reported as
            // separate, non-overlapping phases.
            timer.mark(
              "generation",
              performance.now() - (firstTokenAt ?? anthropicFetchStart),
            );
            console.log(
              `[timing-detail] streaming writes count=${streamingWriteCount} totalMs=${streamingWriteTotalMs.toFixed(1)}`,
            );

            // Final write, unconditional on the throttle, so no trailing
            // partial batch is lost.
            const finalWriteStart = performance.now();
            if (!responseRowId) {
              // Defensive fallback: message_start never arrived for some
              // reason, so there's no row yet — create it now instead of
              // silently dropping the content.
              const { data: inserted, error: insertError } = await supabase
                .from("responses")
                .insert({
                  discussion_id: discussionId,
                  user_id: user.id,
                  prompt_text: promptText,
                  response: accumulatedText,
                  model: ANTHROPIC_MODEL,
                  resolved_model: resolvedModel,
                  cell_type: "assistant",
                })
                .select("id, created_at")
                .single();
              timer.mark("final-db-write", performance.now() - finalWriteStart);

              if (insertError) {
                throw insertError;
              }
              responseRowId = inserted.id as string;
              responseCreatedAt = inserted.created_at as string;
            } else if (accumulatedText !== lastWrittenText) {
              const { error: updateError } = await supabase
                .from("responses")
                .update({ response: accumulatedText })
                .eq("id", responseRowId);
              timer.mark("final-db-write", performance.now() - finalWriteStart);

              if (updateError) {
                throw updateError;
              }
            } else {
              timer.mark("final-db-write", 0);
            }
            break;
          }

          default:
            break;
        }
      }
    }

    return Response.json({
      response: accumulatedText,
      resolved_model: resolvedModel,
      // The real, persisted responses row this run produced -- lets the
      // client append this exact entry directly to its in-memory history
      // instead of only ever learning about it on a future discussion
      // switch's own fetch (persistence audit finding A). Always set by
      // this point: the message_start branch above sets it as soon as
      // the model resolves, and the message_stop branch's own defensive
      // fallback insert (for the pathological case where message_start
      // never arrived) sets it too -- null only if the stream produced
      // neither event at all, which the client treats as "nothing to
      // append" rather than assuming a row exists.
      response_row_id: responseRowId,
      // The row's own database-assigned created_at, set alongside
      // response_row_id above -- the actual moment this response was
      // created (near the start of generation, at message_start), not
      // whenever this request happens to finish returning. Using the
      // client's own "now" at receipt time here would be a genuinely
      // wrong timestamp for anything but the fastest responses, not
      // merely an approximation of a real one.
      response_created_at: responseCreatedAt,
    });
  } catch (error) {
    // The real cause (Anthropic error body, a Supabase error object, a
    // network failure, whatever it is) must always be logged in full here
    // -- this is the only place it's ever seen, and the user-facing
    // response below is deliberately generic, never the raw error. A
    // vague "Execution failed." with nothing logged turned a one-line
    // diagnosis into two rounds of hypothesis-testing once already; see
    // errorId below for matching a user's report back to this line.
    const errorId = crypto.randomUUID();
    const errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);
    console.error(
      `[execute-error] id=${errorId} discussionId=${discussionId}: ${errorMessage}`,
      error instanceof Error ? error.stack : error,
    );
    return Response.json(
      {
        error:
          "Execution failed. Please try again or contact support if this persists.",
        errorId,
      },
      { status: 500 },
    );
  } finally {
    const lockReleaseStart = performance.now();
    await supabase.from("execution_locks").delete().eq("user_id", user.id);
    timer.mark("lock-release", performance.now() - lockReleaseStart);
  }
}

export const POST = withRouteErrorHandling(
  withFullTiming("POST /api/execute", handlePost),
);
