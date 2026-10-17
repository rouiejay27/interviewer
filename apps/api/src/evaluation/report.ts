import type { AppContext } from "../context.js";
import { Rubric } from "../rubric/rubric.js";
import { integrityNotes, type EvaluationResult, type TranscriptEntry } from "./evaluate.js";

/** Everything the recruiter's report page needs for one interview. */
export async function buildReport(ctx: AppContext, sessionId: string) {
  const [s, transcript, evaluation, decisions, consent] = await Promise.all([
    ctx.pool.query<{
      id: string;
      status: string;
      end_reason: string | null;
      created_at: Date;
      ended_at: Date | null;
      candidate_label: string;
      vacancy_id: string;
      vacancy_title: string;
      rubric_version: number;
      rubric: unknown;
    }>(
      `SELECT s.id, s.status, s.end_reason, s.created_at, s.ended_at, i.candidate_label,
         v.id AS vacancy_id, v.title AS vacancy_title, rv.version AS rubric_version, rv.content AS rubric
       FROM sessions s JOIN invites i ON i.id = s.invite_id JOIN vacancies v ON v.id = i.vacancy_id
       JOIN rubric_versions rv ON rv.id = s.rubric_version_id WHERE s.id = $1`,
      [sessionId],
    ),
    ctx.pool.query<{ entries: TranscriptEntry[]; received_at: Date }>(
      "SELECT entries, received_at FROM transcripts WHERE session_id = $1",
      [sessionId],
    ),
    ctx.pool.query<{ status: string; model: string | null; result: EvaluationResult | null; error: string | null; updated_at: Date }>(
      "SELECT status, model, result, error, updated_at FROM evaluations WHERE session_id = $1",
      [sessionId],
    ),
    ctx.pool.query(
      `SELECT d.decision, d.notes, d.created_at, r.display_name AS recruiter
       FROM decisions d JOIN recruiters r ON r.id = d.recruiter_id WHERE d.session_id = $1 ORDER BY d.id DESC`,
      [sessionId],
    ),
    ctx.pool.query(
      "SELECT notice_version, ai_interview, transcript_processing, video_recording, accepted_at FROM consents WHERE session_id = $1",
      [sessionId],
    ),
  ]);
  const session = s.rows[0]!;
  const rubric = Rubric.parse(session.rubric);
  const entries = transcript.rows[0]?.entries ?? [];
  return {
    interview: {
      id: session.id,
      status: session.status,
      endReason: session.end_reason,
      startedAt: session.created_at,
      endedAt: session.ended_at,
      candidateLabel: session.candidate_label,
    },
    vacancy: { id: session.vacancy_id, title: session.vacancy_title },
    rubric: { version: session.rubric_version, content: rubric },
    consent: consent.rows[0] ?? null,
    transcript: transcript.rows[0] ? { entries, receivedAt: transcript.rows[0].received_at } : null,
    evaluation: evaluation.rows[0] ?? null,
    integrity: transcript.rows[0] ? integrityNotes(session.end_reason, entries, rubric.questions.length) : [],
    decisions: decisions.rows,
  };
}
