import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { safeEqual, sha256, type AppContext } from "../context.js";

const TavusEvent = z
  .object({
    event_type: z.string(),
    conversation_id: z.string().optional(),
    message_type: z.string().optional(),
    timestamp: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const TranscriptEntry = z
  .object({ role: z.string(), content: z.string() })
  .loose();

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Querystring: { token?: string } }>("/webhooks/tavus", async (req, reply) => {
    if (!safeEqual(req.query.token, ctx.config.WEBHOOK_SECRET)) {
      req.log.warn("webhook rejected: bad token");
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = TavusEvent.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid event" });
    const ev = parsed.data;

    // Retries and duplicates share a key, so each event is processed once.
    const dedupeKey = `${ev.conversation_id ?? "none"}:${ev.event_type}:${ev.timestamp ?? sha256(JSON.stringify(req.body))}`;
    const inserted = await ctx.pool.query(
      `INSERT INTO webhook_events (dedupe_key, conversation_id, event_type, payload)
       VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [dedupeKey, ev.conversation_id ?? null, ev.event_type, JSON.stringify(req.body)],
    );
    if (!inserted.rowCount) {
      req.log.info({ eventType: ev.event_type }, "duplicate webhook ignored");
      return { ok: true, duplicate: true };
    }

    const session = ev.conversation_id
      ? (
          await ctx.pool.query<{ id: string }>("SELECT id FROM sessions WHERE tavus_conversation_id = $1", [
            ev.conversation_id,
          ])
        ).rows[0]
      : undefined;

    if (ev.event_type === "system.shutdown" && session) {
      const reason = typeof ev.properties?.shutdown_reason === "string" ? ev.properties.shutdown_reason : "shutdown";
      await ctx.pool.query(
        `UPDATE sessions SET status = 'ended', end_reason = COALESCE(end_reason, $2), ended_at = COALESCE(ended_at, now())
         WHERE id = $1`,
        [session.id, reason],
      );
    }

    if (ev.event_type === "application.transcription_ready" && session) {
      const entries = z.array(TranscriptEntry).safeParse(ev.properties?.transcript);
      if (entries.success) {
        // The provider's transcript includes its placeholder system prompt; keep only spoken turns.
        const spoken = entries.data.filter((e) => e.role === "user" || e.role === "assistant");
        await ctx.pool.query(
          "INSERT INTO transcripts (session_id, entries) VALUES ($1, $2) ON CONFLICT (session_id) DO NOTHING",
          [session.id, JSON.stringify(spoken)],
        );
      } else {
        req.log.warn({ sessionId: session.id }, "transcription_ready had no usable transcript");
      }
    }

    req.log.info({ eventType: ev.event_type, sessionId: session?.id }, "webhook processed");
    return { ok: true };
  });
}
