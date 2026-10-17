import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { safeEqual, type AppContext } from "../context.js";
import { POC_SCRIPT } from "../interview/script.js";
import { endInterviewSession, startInterviewSession, StartError } from "../interview/start.js";

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
    try {
      return await startInterviewSession(ctx, {
        greeting: POC_SCRIPT.greeting,
        conversationLabel: "PoC",
        log: req.log,
      });
    } catch (err) {
      if (err instanceof StartError) return reply.code(err.httpStatus).send({ error: err.message, detail: err.detail });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/end", async (req, reply) => {
    if (!requireAccess(req, reply)) return;
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "Bad session id." });
    const exists = await ctx.pool.query("SELECT 1 FROM sessions WHERE id = $1", [req.params.id]);
    if (!exists.rowCount) return reply.code(404).send({ error: "Session not found." });
    if (!(await endInterviewSession(ctx, req.params.id, "ended_by_user"))) {
      req.log.warn({ sessionId: req.params.id }, "End Conversation call failed; sweeper will retry");
      return reply.code(502).send({ error: "Provider did not confirm the end. The cleanup job will retry." });
    }
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
