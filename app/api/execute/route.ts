import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { trace, context } from "@opentelemetry/api";

const tracer = trace.getTracer("pact-api");

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
// updates faster than this anyway.
//
// Was 500ms until task 18. Task 12's baseline round measured these
// throttled writes costing 19-34% of total request time across five real
// discussions (write count tracks generation_ms / interval almost
// exactly -- confirmed there, not assumed) -- the interval was short
// enough, relative to how long these responses actually run, that its
// cumulative per-call overhead (auth/RLS/PostgREST overhead per HTTP
// round trip, not the UPDATE's own cost -- the same ~100-300ms per-call
// floor shows up on auth/lock-acquire/settings-read too, all unrelated
// to payload size) became a real, measurable chunk of wall time. Raised
// 4x (task 18's evaluation: this dominates the write count for any
// throttle scheme, so a length/token-based trigger buys little extra
// over just raising the interval; moving off Postgres UPDATEs onto
// Realtime broadcast would eliminate the cost entirely but means
// rewriting the live-preview's whole data path -- see task 18's report
// for the full trade-off). Live-preview UI (`postgres_changes`
// subscription in useDiscussionExecution.ts) now updates roughly every
// 2s during generation instead of every 500ms -- still clearly
// perceived as "streaming" at human reading speed, not choppy.
const STREAM_WRITE_THROTTLE_MS = 2000;

interface ExecuteRequestBody {
  discussionId: string;
  promptText: string;
}

async function handlePost(request: Request) {
  const requestStartDate = Date.now();
  const supabase = await createClient();

  const authStart = Date.now();
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
  const authMs = Date.now() - authStart;

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
  // Attaches to the automatic root span @vercel/otel creates for this
  // route invocation -- an attribute, not part of the span name, since
  // high-cardinality values (a per-request uuid) belong on attributes,
  // not names. Replaces the old HandlerTimer.setLabel mechanism.
  trace.getActiveSpan()?.setAttribute("pact.discussion_id", discussionId);

  if (typeof promptText !== "string" || promptText.trim().length === 0) {
    return Response.json(
      { error: "promptText is required and must be a non-empty string." },
      { status: 400 },
    );
  }

  const lockAcquireStart = Date.now();
  const { acquired, lockError } = await tracer.startActiveSpan(
    "lock-acquire",
    async (span) => {
      try {
        const { data, error } = await supabase.rpc(
          "try_acquire_execution_lock",
          { p_user_id: user.id, p_discussion_id: discussionId },
        );
        return { acquired: data, lockError: error };
      } finally {
        span.end();
      }
    },
  );
  const lockAcquireMs = Date.now() - lockAcquireStart;

  if (lockError) {
    throw lockError;
  }

  if (!acquired) {
    return Response.json(
      { error: "An execution is already in progress for this user." },
      { status: 409 },
    );
  }

  // Everything below this point is a genuine execution attempt (the lock
  // is ours) -- this is also the boundary execution_timings uses for
  // "does this run get a row at all" (see the finally block below): a
  // failed auth, malformed request, missing API key, or lost lock race
  // never reaches here, so none of those produce a row. Once we're past
  // this point, a row is written unconditionally, however far the
  // execution actually gets -- see the finally block's own comment for
  // why "only fully-succeeded runs" would be the wrong call for a
  // latency report specifically.
  let maxTokens: number | null = null;
  let resolvedModel: string | null = null;
  let settingsReadMs: number | null = null;
  let anthropicConnectMs: number | null = null;
  let messageStartInsertMs: number | null = null;
  let timeToFirstTokenMs: number | null = null;
  let generationMs: number | null = null;
  let finalWriteMs: number | null = null;
  let streamingWriteCount = 0;
  let streamingWriteTotalMs = 0;

  // time-to-first-token's own lifetime spans multiple iterations of the
  // SSE read loop below (from the Anthropic fetch call until the first
  // real text_delta), so it can't be a single startActiveSpan callback the
  // way the other phases are -- it's opened here and closed wherever the
  // first token actually arrives (or, failing that, in the outer finally
  // below). ttftCtx is what anthropic-connect and message-start-insert
  // are created inside of, so they register as its children rather than
  // as siblings under the route's root span -- ttft *contains* both of
  // them (confirmed against task 12's data: connect + insert account for
  // essentially all of the old flat ttfb mark, to within ~1ms), it isn't
  // a third phase alongside them.
  const ttftStartDate = Date.now();
  const ttftSpan = tracer.startSpan("time-to-first-token", {
    startTime: ttftStartDate,
  });
  const ttftCtx = trace.setSpan(context.active(), ttftSpan);
  let ttftEnded = false;
  function endTtft(endDate?: number) {
    if (!ttftEnded) {
      ttftEnded = true;
      const resolvedEndDate = endDate ?? Date.now();
      ttftSpan.end(resolvedEndDate);
      timeToFirstTokenMs = resolvedEndDate - ttftStartDate;
    }
  }

  try {
    // Global, admin-configurable cap (see app_settings / 20260913035840)
    // -- replaces the old hardcoded max_tokens: 1000, which is exactly
    // what caused the truncated long responses found in the earlier
    // timing investigation. A missing/unreadable settings row falls back
    // to that same old value rather than failing the run.
    const settingsReadStart = Date.now();
    maxTokens = await tracer.startActiveSpan("settings-read", async (span) => {
      try {
        const { data: settings, error: settingsError } = await supabase
          .from("app_settings")
          .select("max_tokens")
          .eq("id", 1)
          .maybeSingle();

        if (settingsError || !settings) {
          console.error(
            `[app-settings-fallback] Could not read app_settings (id=1) -- falling back to max_tokens=${FALLBACK_MAX_TOKENS}.`,
            settingsError ?? "no row found",
          );
          return FALLBACK_MAX_TOKENS;
        }
        return settings.max_tokens;
      } finally {
        span.end();
      }
    });
    settingsReadMs = Date.now() - settingsReadStart;

    const anthropicConnectStart = Date.now();
    const anthropicResponse = await context.with(ttftCtx, () =>
      tracer.startActiveSpan("anthropic-connect", async (span) => {
        try {
          return await fetch(ANTHROPIC_API_URL, {
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
        } finally {
          span.end();
        }
      }),
    );
    anthropicConnectMs = Date.now() - anthropicConnectStart;

    if (!anthropicResponse.ok || !anthropicResponse.body) {
      endTtft();
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

    let accumulatedText = "";
    let responseRowId: string | null = null;
    let responseCreatedAt: string | null = null;
    // Seeded to "now" rather than 0, so the throttle genuinely applies to
    // the first delta too — otherwise Date.now() - 0 is always well past
    // the threshold and the very first delta bypasses it.
    let lastWriteAt = Date.now();
    let lastWrittenText = "";

    // Streaming-phase timing state — firstTokenAtDate marks the end of
    // time-to-first-token and the start of generation. The write
    // counters feed the throttled-writes span's attributes (a single
    // aggregated span, not one child span per write — see task 13/14: at
    // up to ~300 writes for one long response, per-write spans would be
    // real clutter in the waterfall for no diagnostic value beyond what
    // count/total/avg already give).
    let firstTokenAtDate: number | null = null;
    let firstWriteAtDate: number | null = null;

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
            // arrived. A child of time-to-first-token, not of
            // anthropic-connect (which has already ended by this point) —
            // both are ttft's own children, not nested under each other.
            const messageStartInsertStart = Date.now();
            const inserted = await context.with(ttftCtx, () =>
              tracer.startActiveSpan("message-start-insert", async (span) => {
                try {
                  const { data, error: insertError } = await supabase
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
                  if (insertError) {
                    throw insertError;
                  }
                  return data;
                } finally {
                  span.end();
                }
              }),
            );
            messageStartInsertMs = Date.now() - messageStartInsertStart;
            responseRowId = inserted.id as string;
            responseCreatedAt = inserted.created_at as string;
            break;
          }

          case "content_block_delta": {
            const delta = event.delta as
              { type?: string; text?: string } | undefined;
            if (delta?.type === "text_delta" && delta.text) {
              if (firstTokenAtDate === null) {
                firstTokenAtDate = Date.now();
                endTtft(firstTokenAtDate);
              }
              accumulatedText += delta.text;
            }

            const now = Date.now();
            if (
              responseRowId &&
              accumulatedText !== lastWrittenText &&
              now - lastWriteAt >= STREAM_WRITE_THROTTLE_MS
            ) {
              if (firstWriteAtDate === null) {
                firstWriteAtDate = now;
              }
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
            // Safety net: only fires if no text_delta ever arrived (an
            // empty or entirely-non-text response), so ttft wasn't
            // already ended above.
            endTtft();

            // Retroactive span: both endpoints (firstTokenAtDate, now)
            // are already known by the time execution reaches here, so
            // this is created and ended in one step rather than kept
            // open across the loop the way time-to-first-token is.
            // Non-overlapping with time-to-first-token by construction —
            // confirmed against the route's own logic (this is the same
            // firstTokenAt-to-message_stop measurement task 13 asked to
            // re-verify, not a new one).
            const generationStartDate = firstTokenAtDate ?? ttftStartDate;
            const generationEndDate = Date.now();
            tracer
              .startSpan("generation", { startTime: generationStartDate })
              .end(generationEndDate);
            generationMs = generationEndDate - generationStartDate;

            // Aggregated span for every throttled UPDATE this response
            // made — see the comment above streamingWriteCount for why
            // this is one span with attributes rather than one span per
            // write.
            const writesSpan = tracer.startSpan(
              "throttled-writes",
              firstWriteAtDate !== null
                ? { startTime: firstWriteAtDate }
                : undefined,
            );
            writesSpan.setAttributes({
              "write.count": streamingWriteCount,
              "write.total_duration_ms": Number(
                streamingWriteTotalMs.toFixed(1),
              ),
              "write.avg_duration_ms":
                streamingWriteCount > 0
                  ? Number(
                      (streamingWriteTotalMs / streamingWriteCount).toFixed(1),
                    )
                  : 0,
            });
            writesSpan.end(
              firstWriteAtDate !== null ? generationEndDate : undefined,
            );

            const finalWriteStart = Date.now();
            await tracer.startActiveSpan("final-write", async (span) => {
              try {
                // Final write, unconditional on the throttle, so no
                // trailing partial batch is lost.
                if (!responseRowId) {
                  // Defensive fallback: message_start never arrived for
                  // some reason, so there's no row yet — create it now
                  // instead of silently dropping the content.
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
                  if (updateError) {
                    throw updateError;
                  }
                }
              } finally {
                span.end();
              }
            });
            finalWriteMs = Date.now() - finalWriteStart;
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
    // Safety net: guarantees ttft is never left open if something threw
    // before either of the two normal end points (the error check right
    // after anthropic-connect, or the first text_delta) was reached.
    endTtft();
    const lockReleaseStart = Date.now();
    await tracer.startActiveSpan("lock-release", async (span) => {
      try {
        await supabase.from("execution_locks").delete().eq("user_id", user.id);
      } finally {
        span.end();
      }
    });
    const lockReleaseMs = Date.now() - lockReleaseStart;

    // Durable counterpart to the spans above (task 13 Option B /
    // task 15): one row per genuine execution attempt -- everything
    // from here down only ever runs once the lock was actually
    // acquired, so a failed auth, malformed request, missing API key,
    // or lost lock race never produces a row; those aren't executions.
    // Deliberately unconditional beyond that boundary, though -- this
    // block runs whether the try above returned successfully or threw,
    // so a run that fails partway through (a bad Anthropic response, a
    // DB error mid-stream) still gets a row, with whichever ms columns
    // never got assigned left null. A "only insert on full success"
    // rule would silently exclude exactly the slow-then-failed runs a
    // latency report most needs to see -- the failure paths above are
    // real (a truncated Anthropic connection, a thrown Supabase error
    // mid-loop), not hypothetical, so this isn't a corner nobody hits.
    //
    // Wrapped in its own try/catch, never rethrown: this is diagnostic
    // data, not core functionality, and it runs after the try/catch
    // above has already produced (or is about to produce, on the way
    // back up through this finally) the real response. A throw
    // reaching the top of this finally block would replace that
    // response with withRouteErrorHandling's generic 500 -- turning a
    // successful execution into an apparent failure for the client
    // over a broken diagnostic insert. That must never happen, so
    // every failure mode here (a returned `error`, or an actual thrown
    // exception from the call itself) is caught and only logged.
    try {
      const totalMs = Date.now() - requestStartDate;
      const { error: timingInsertError } = await supabase
        .from("execution_timings")
        .insert({
          user_id: user.id,
          discussion_id: discussionId,
          resolved_model: resolvedModel,
          max_tokens: maxTokens,
          auth_ms: authMs,
          lock_acquire_ms: lockAcquireMs,
          settings_read_ms: settingsReadMs,
          anthropic_connect_ms: anthropicConnectMs,
          message_start_insert_ms: messageStartInsertMs,
          time_to_first_token_ms: timeToFirstTokenMs,
          generation_ms: generationMs,
          throttled_write_count: streamingWriteCount,
          throttled_write_total_ms: Math.round(streamingWriteTotalMs),
          final_write_ms: finalWriteMs,
          lock_release_ms: lockReleaseMs,
          total_ms: totalMs,
        });
      if (timingInsertError) {
        console.error("[execution-timings-insert-failed]", timingInsertError);
      }
    } catch (timingInsertException) {
      console.error("[execution-timings-insert-failed]", timingInsertException);
    }
  }
}

export const POST = withRouteErrorHandling(handlePost);
