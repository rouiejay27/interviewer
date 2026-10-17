import type { FastifyBaseLogger } from "fastify";
import { tavusAuth } from "./config.js";
import type { AppContext } from "./context.js";
import { endConversation } from "./tavus.js";

/**
 * Safety net for provider sessions left open (tab closed, crash, missed webhook).
 * Any "active" session older than its cap + 2 minutes is ended at the provider and marked ended.
 */
export function startSweeper(ctx: AppContext, log: FastifyBaseLogger, everyMs = 60_000): () => void {
  const run = async () => {
    const stale = await ctx.pool.query<{ id: string; tavus_conversation_id: string | null }>(
      `SELECT id, tavus_conversation_id FROM sessions
       WHERE status IN ('active', 'creating')
         AND created_at < now() - make_interval(secs => max_call_seconds + 120)`,
    );
    for (const s of stale.rows) {
      try {
        if (s.tavus_conversation_id) await endConversation(tavusAuth(ctx.config), s.tavus_conversation_id);
        await ctx.pool.query(
          "UPDATE sessions SET status = 'ended', end_reason = COALESCE(end_reason, 'sweeper'), ended_at = now() WHERE id = $1",
          [s.id],
        );
        log.warn({ sessionId: s.id }, "sweeper ended a stale session");
      } catch (err) {
        log.error({ sessionId: s.id, err: (err as Error).message }, "sweeper could not end session; will retry");
      }
    }
  };
  const timer = setInterval(() => void run().catch((e: Error) => log.error({ err: e.message }, "sweeper run failed")), everyMs);
  void run().catch(() => undefined);
  return () => clearInterval(timer);
}
