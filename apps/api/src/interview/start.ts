import { randomUUID } from "node:crypto";
import { tavusAuth } from "../config.js";
import type { AppContext } from "../context.js";
import { createConversation, endConversation, TavusError } from "../tavus.js";

export class StartError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface StartedSession {
  sessionId: string;
  joinUrl: string;
  maxCallSeconds: number;
  testMode: boolean;
}

/**
 * Creates one provider conversation for a session. Shared by the Phase 1 test page
 * and the applicant link flow so there is a single media pipeline.
 */
export async function startInterviewSession(
  ctx: AppContext,
  opts: {
    greeting: string;
    conversationLabel: string;
    inviteId?: string;
    rubricVersionId?: string;
    log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
  },
): Promise<StartedSession> {
  if (!ctx.config.TAVUS_PAL_ID) {
    throw new StartError("TAVUS_PAL_ID is empty. Run `npm run create-pal` first.", 500);
  }
  const active = await ctx.pool.query("SELECT 1 FROM sessions WHERE status IN ('active', 'creating')");
  if (active.rowCount) {
    throw new StartError("Another interview is in progress. Please try again in a few minutes.", 409);
  }

  const sessionId = randomUUID();
  const maxCallSeconds = ctx.config.MAX_CALL_SECONDS;
  try {
    await ctx.pool.query(
      "INSERT INTO sessions (id, max_call_seconds, invite_id, rubric_version_id) VALUES ($1, $2, $3, $4)",
      [sessionId, maxCallSeconds, opts.inviteId ?? null, opts.rubricVersionId ?? null],
    );
  } catch (err) {
    // sessions_one_live_idx: someone else started a call at the same moment.
    if ((err as { code?: string }).code === "23505") {
      throw new StartError("Another interview is in progress. Please try again in a few minutes.", 409);
    }
    throw err;
  }

  try {
    const conv = await createConversation(tavusAuth(ctx.config), {
      palId: ctx.config.TAVUS_PAL_ID,
      sessionId,
      conversationName: `iNTERVIEWER ${opts.conversationLabel} ${sessionId.slice(0, 8)}`,
      callbackUrl: `${ctx.config.PUBLIC_BASE_URL}/webhooks/tavus?token=${encodeURIComponent(ctx.config.WEBHOOK_SECRET)}`,
      greeting: opts.greeting,
      maxCallSeconds,
      testMode: ctx.config.TAVUS_TEST_MODE,
    });
    const testMode = ctx.config.TAVUS_TEST_MODE;
    await ctx.pool.query(
      "UPDATE sessions SET tavus_conversation_id = $2, status = $3, end_reason = $4, ended_at = $5 WHERE id = $1",
      [sessionId, conv.conversation_id, testMode ? "ended" : "active", testMode ? "test_mode" : null, testMode ? new Date() : null],
    );
    const joinUrl = conv.meeting_token
      ? `${conv.conversation_url}?t=${encodeURIComponent(conv.meeting_token)}`
      : conv.conversation_url;
    opts.log.info({ sessionId, conversationId: conv.conversation_id, testMode }, "session created");
    return { sessionId, joinUrl, maxCallSeconds, testMode };
  } catch (err) {
    const detail = err instanceof TavusError ? `${err.message}: ${err.body}` : (err as Error).message;
    opts.log.error({ sessionId, detail }, "Tavus conversation creation failed");
    await ctx.pool.query("UPDATE sessions SET status = 'failed', end_reason = 'create_failed', ended_at = now() WHERE id = $1", [
      sessionId,
    ]);
    throw new StartError("Could not start the avatar call.", 502, detail);
  }
}

/**
 * Ends a session at the provider (if still active) and marks it ended. Idempotent.
 * Returns false when the provider did not confirm; the sweeper retries later.
 */
export async function endInterviewSession(ctx: AppContext, sessionId: string, reason: string): Promise<boolean> {
  const row = await ctx.pool.query<{ tavus_conversation_id: string | null; status: string }>(
    "SELECT tavus_conversation_id, status FROM sessions WHERE id = $1",
    [sessionId],
  );
  const s = row.rows[0];
  if (!s) return true;
  if (s.status === "active" && s.tavus_conversation_id) {
    try {
      await endConversation(tavusAuth(ctx.config), s.tavus_conversation_id);
    } catch {
      return false;
    }
  }
  await ctx.pool.query(
    `UPDATE sessions SET status = CASE WHEN status = 'failed' THEN status ELSE 'ended' END,
       end_reason = COALESCE(end_reason, $2), ended_at = COALESCE(ended_at, now()) WHERE id = $1`,
    [sessionId, reason],
  );
  return true;
}
