import type { AppContext } from "../context.js";
import { completeJson } from "../llm/grok.js";
import { Rubric } from "../rubric/rubric.js";
import { buildEvaluationMessages, EVALUATION_JSON_SCHEMA, finalizeEvaluation, type TranscriptEntry } from "./evaluate.js";

type Log = { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
const MAX_ATTEMPTS = 3;

/** Marks an interview for evaluation and starts it in the background. */
export async function queueEvaluation(ctx: AppContext, sessionId: string, opts: { reset?: boolean; log: Log }): Promise<void> {
  await ctx.pool.query(
    opts.reset
      ? `INSERT INTO evaluations (session_id) VALUES ($1)
         ON CONFLICT (session_id) DO UPDATE SET status = 'pending', attempts = 0, error = NULL, updated_at = now()
         WHERE evaluations.status <> 'running' OR evaluations.updated_at < now() - interval '5 minutes'`
      : "INSERT INTO evaluations (session_id) VALUES ($1) ON CONFLICT (session_id) DO NOTHING",
    [sessionId],
  );
  setImmediate(() => void runEvaluation(ctx, sessionId, opts.log));
}

/**
 * Runs one evaluation. The row is claimed atomically, so a webhook retry, the sweeper,
 * and a manual re-run can never evaluate the same interview twice at once.
 */
export async function runEvaluation(ctx: AppContext, sessionId: string, log: Log): Promise<void> {
  const claim = await ctx.pool.query(
    `UPDATE evaluations SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE session_id = $1 AND attempts < $2
       AND (status IN ('pending', 'failed') OR (status = 'running' AND updated_at < now() - interval '5 minutes'))
     RETURNING attempts`,
    [sessionId, MAX_ATTEMPTS],
  );
  if (!claim.rowCount) return;

  try {
    const row = await ctx.pool.query<{ content: unknown; entries: TranscriptEntry[] }>(
      `SELECT rv.content, t.entries FROM sessions s
       JOIN rubric_versions rv ON rv.id = s.rubric_version_id
       JOIN transcripts t ON t.session_id = s.id
       WHERE s.id = $1`,
      [sessionId],
    );
    const data = row.rows[0];
    if (!data) throw new Error("rubric or transcript missing");
    const rubric = Rubric.parse(data.content);
    const entries = data.entries;

    let result;
    if (!entries.some((e) => e.role === "user")) {
      // Nothing to assess: skip the model call entirely.
      result = finalizeEvaluation(rubric, entries, { criteria: [], unresolved: ["The applicant gave no answers."] });
    } else {
      const { data: raw } = await completeJson({
        baseUrl: ctx.config.XAI_BASE_URL,
        apiKey: ctx.config.XAI_API_KEY,
        model: ctx.config.XAI_EVAL_MODEL,
        messages: buildEvaluationMessages(rubric, entries),
        schemaName: "interview_evaluation",
        schema: EVALUATION_JSON_SCHEMA as unknown as Record<string, unknown>,
      });
      result = finalizeEvaluation(rubric, entries, raw);
    }

    await ctx.pool.query(
      "UPDATE evaluations SET status = 'done', model = $2, result = $3, error = NULL, updated_at = now() WHERE session_id = $1",
      [sessionId, ctx.config.XAI_EVAL_MODEL, JSON.stringify(result)],
    );
    log.info({ sessionId, coverage: result.coverage }, "evaluation done");
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    await ctx.pool.query("UPDATE evaluations SET status = 'failed', error = $2, updated_at = now() WHERE session_id = $1", [
      sessionId,
      message,
    ]);
    log.error({ sessionId, err: message }, "evaluation failed");
  }
}

/** Called by the sweeper: retries failed or stuck evaluations with a short back-off. */
export async function retryEvaluations(ctx: AppContext, log: Log): Promise<void> {
  // A run that died mid-way on its last attempt would otherwise stay "running" forever.
  await ctx.pool.query(
    `UPDATE evaluations SET status = 'failed', error = 'stopped unexpectedly; use Re-run', updated_at = now()
     WHERE status = 'running' AND attempts >= $1 AND updated_at < now() - interval '5 minutes'`,
    [MAX_ATTEMPTS],
  );
  const due = await ctx.pool.query<{ session_id: string }>(
    `SELECT session_id FROM evaluations
     WHERE attempts < $1 AND (
       (status = 'pending' AND updated_at < now() - interval '1 minute') OR
       (status = 'failed' AND updated_at < now() - interval '2 minutes') OR
       (status = 'running' AND updated_at < now() - interval '5 minutes'))
     LIMIT 5`,
    [MAX_ATTEMPTS],
  );
  for (const r of due.rows) await runEvaluation(ctx, r.session_id, log);
}
