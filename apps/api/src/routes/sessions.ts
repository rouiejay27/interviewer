import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { tavusAuth } from "../config.js";
import { safeEqual, type AppContext } from "../context.js";
import { POC_SCRIPT } from "../interview/script.js";
import { createConversation, endConversation, TavusError } from "../tavus.js";

const UUID_RE = /^[0-9a-f-]{36}$/i;

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  // PoC-only gate. Phase 3 replaces this with recruiter login and single-use applicant links.
  function requireAccess(req: FastifyRequest, reply: FastifyReply): boolean {
    const token = req.headers["x-poc-token"];
    if (!safeEqual(typeof token === "string" ? token : undefined, ctx.config.POC_ACCESS_TOKEN)) {
      void reply.code(401).send({ error: "Access token is missing or wrong." });
      return false;
    }
    return true;
  }

  app.post("/api/sessions", async (req, reply) => {
    if (!requireAccess(req, reply)) return;
    if (!ctx.config.TAVUS_PAL_ID) {
      return reply.code(500).send({ error: "TAVUS_PAL_ID is empty. Run `npm run create-pal` first." });
    }

    const active = await ctx.pool.query("SELECT 1 FROM sessions WHERE status = 'active'");
    if (active.rowCount) {
      return reply.code(409).send({ error: "A session is already active. End it first (free plan allows one call)." });
    }

    const sessionId = randomUUID();
    const maxCallSeconds = ctx.config.MAX_CALL_SECONDS;
    await ctx.pool.query("INSERT INTO sessions (id, max_call_seconds) VALUES ($1, $2)", [sessionId, maxCallSeconds]);

    try {
      const conv = await createConversation(tavusAuth(ctx.config), {
        palId: ctx.config.TAVUS_PAL_ID,
        sessionId,
        callbackUrl: `${ctx.config.PUBLIC_BASE_URL}/webhooks/tavus?token=${encodeURIComponent(ctx.config.WEBHOOK_SECRET)}`,
        greeting: POC_SCRIPT.greeting,
        maxCallSeconds,
        testMode: ctx.config.TAVUS_TEST_MODE,
      });
      const status = ctx.config.TAVUS_TEST_MODE ? "ended" : "active";
      await ctx.pool.query(
        "UPDATE sessions SET tavus_conversation_id = $2, status = $3, end_reason = $4 WHERE id = $1",
        [sessionId, conv.conversation_id, status, ctx.config.TAVUS_TEST_MODE ? "test_mode" : null],
      );
      const joinUrl = conv.meeting_token
        ? `${conv.conversation_url}?t=${encodeURIComponent(conv.meeting_token)}`
        : conv.conversation_url;
      req.log.info({ sessionId, conversationId: conv.conversation_id, testMode: ctx.config.TAVUS_TEST_MODE }, "session created");
      return { sessionId, joinUrl, maxCallSeconds, testMode: ctx.config.TAVUS_TEST_MODE };
    } catch (err) {
      const detail = err instanceof TavusError ? `${err.message}: ${err.body}` : (err as Error).message;
      req.log.error({ sessionId, detail }, "Tavus conversation creation failed");
      await ctx.pool.query("UPDATE sessions SET status = 'failed', end_reason = $2, ended_at = now() WHERE id = $1", [
        sessionId,
        "create_failed",
      ]);
      return reply.code(502).send({ error: "Could not start the avatar call.", detail });
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/end", async (req, reply) => {
    if (!requireAccess(req, reply)) return;
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "Bad session id." });
    const row = await ctx.pool.query<{ tavus_conversation_id: string | null; status: string }>(
      "SELECT tavus_conversation_id, status FROM sessions WHERE id = $1",
      [req.params.id],
    );
    const s = row.rows[0];
    if (!s) return reply.code(404).send({ error: "Session not found." });
    if (s.status === "active" && s.tavus_conversation_id) {
      try {
        await endConversation(tavusAuth(ctx.config), s.tavus_conversation_id);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, "End Conversation call failed; sweeper will retry");
        return reply.code(502).send({ error: "Provider did not confirm the end. The cleanup job will retry." });
      }
    }
    await ctx.pool.query(
      "UPDATE sessions SET status = 'ended', end_reason = COALESCE(end_reason, 'ended_by_user'), ended_at = COALESCE(ended_at, now()) WHERE id = $1",
      [req.params.id],
    );
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    if (!requireAccess(req, reply)) return;
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "Bad session id." });
    const [session, transcript, turns] = await Promise.all([
      ctx.pool.query(
        "SELECT id, tavus_conversation_id, status, end_reason, max_call_seconds, created_at, ended_at FROM sessions WHERE id = $1",
        [req.params.id],
      ),
      ctx.pool.query("SELECT entries, received_at FROM transcripts WHERE session_id = $1", [req.params.id]),
      ctx.pool.query(
        "SELECT role, content, next_action, first_token_ms, created_at FROM turn_log WHERE session_id = $1 ORDER BY id",
        [req.params.id],
      ),
    ]);
    if (!session.rows[0]) return reply.code(404).send({ error: "Session not found." });
    return { session: session.rows[0], transcript: transcript.rows[0] ?? null, turnLog: turns.rows };
  });
}
