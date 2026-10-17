import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { audit } from "../auth.js";
import { sha256, type AppContext } from "../context.js";
import { endInterviewSession, startInterviewSession, StartError } from "../interview/start.js";
import { greetingFor, Rubric } from "../rubric/rubric.js";

/** Bump when the notice text below changes; the version is stored with each consent. */
export const NOTICE_VERSION = "2026-10-18.1";

export const NOTICE = {
  version: NOTICE_VERSION,
  points: [
    "You will talk with an AI interviewer shown as a video avatar. It is not a person.",
    "The AI asks the same core questions every applicant for this role gets, plus short follow-ups.",
    "What you say is turned into a written transcript. The transcript is used to prepare a summary for a human recruiter.",
    "A human recruiter reviews your answers and makes every decision. The AI does not decide.",
    "No video or audio recording is stored. Your face, voice tone, accent, and emotions are not analyzed.",
    "If you prefer not to talk with an AI, you can ask for an interview with a person instead.",
  ],
};

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const StartBody = z.object({
  consentAiInterview: z.literal(true),
  consentTranscript: z.literal(true),
  noticeVersion: z.literal(NOTICE_VERSION),
});

interface InviteRow {
  id: string;
  status: string;
  expired: boolean;
  vacancy_title: string;
  rubric_version_id: string;
  rubric: unknown;
}

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

export function registerApplicantRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function findInvite(token: string): Promise<InviteRow | undefined> {
    if (!TOKEN_RE.test(token)) return undefined;
    const r = await ctx.pool.query<InviteRow>(
      `SELECT i.id, i.status, (i.expires_at < now()) AS expired, v.title AS vacancy_title,
         i.rubric_version_id, rv.content AS rubric
       FROM invites i JOIN vacancies v ON v.id = i.vacancy_id JOIN rubric_versions rv ON rv.id = i.rubric_version_id
       WHERE i.token_hash = $1`,
      [sha256(token)],
    );
    return r.rows[0];
  }

  function gone(reply: FastifyReply) {
    // Same answer for unknown, revoked, and expired links, so links cannot be probed.
    return reply.code(410).send({ error: "This interview link is not valid or has expired. Please contact the recruiter." });
  }

  // The applicant page itself. The token stays in the path; logs strip it (see server.ts).
  app.get("/i/:token", async (_req, reply) => {
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    return reply.sendFile("apply.html", publicDir);
  });

  app.get<{ Params: { token: string } }>("/api/applicant/:token", async (req, reply) => {
    const invite = await findInvite(req.params.token);
    if (!invite || invite.status === "revoked" || (invite.expired && invite.status === "pending")) return gone(reply);
    const rubric = Rubric.parse(invite.rubric);
    return {
      roleTitle: invite.vacancy_title,
      status: invite.status, // pending | started | completed | human_requested
      questionCount: rubric.questions.length,
      maxMinutes: Math.round(ctx.config.MAX_CALL_SECONDS / 60),
      notice: NOTICE,
    };
  });

  app.post<{ Params: { token: string } }>("/api/applicant/:token/start", async (req, reply) => {
    const invite = await findInvite(req.params.token);
    if (!invite || invite.status === "revoked" || (invite.expired && invite.status === "pending")) return gone(reply);
    const body = StartBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Please read the notice and tick both boxes to continue." });

    // Claim the link atomically: a double click or a second tab cannot start two calls.
    const claim = await ctx.pool.query(
      "UPDATE invites SET status = 'started', started_at = now() WHERE id = $1 AND status = 'pending' AND expires_at > now()",
      [invite.id],
    );
    if (!claim.rowCount) return reply.code(409).send({ error: "This interview link has already been used." });

    const rubric = Rubric.parse(invite.rubric);
    // Record consent before any call exists, so no call can run without it.
    const consentId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO consents (id, invite_id, notice_version, ai_interview, transcript_processing, video_recording)
       VALUES ($1, $2, $3, true, true, false)`,
      [consentId, invite.id, NOTICE_VERSION],
    );
    let sessionId: string | undefined;
    try {
      const started = await startInterviewSession(ctx, {
        greeting: greetingFor(rubric),
        conversationLabel: "interview",
        inviteId: invite.id,
        rubricVersionId: invite.rubric_version_id,
        log: req.log,
      });
      sessionId = started.sessionId;
      await ctx.pool.query("UPDATE consents SET session_id = $2 WHERE id = $1", [consentId, sessionId]);
      await audit(ctx, { actorType: "applicant", action: "interview.start", targetType: "session", targetId: sessionId });
      return { joinUrl: started.joinUrl, maxCallSeconds: started.maxCallSeconds, testMode: started.testMode };
    } catch (err) {
      // Never leave a provider call running that the applicant cannot see.
      if (sessionId) await endInterviewSession(ctx, sessionId, "start_failed").catch(() => undefined);
      await ctx.pool.query("DELETE FROM consents WHERE id = $1 AND session_id IS NULL", [consentId]);
      // Release the link so the applicant can try again after a provider or capacity error.
      await ctx.pool.query("UPDATE invites SET status = 'pending', started_at = NULL WHERE id = $1 AND status = 'started'", [
        invite.id,
      ]);
      if (err instanceof StartError) {
        req.log.warn({ status: err.httpStatus }, "applicant start failed");
        const message = err.httpStatus === 409 ? err.message : "The interview could not start. Please try again in a minute.";
        return reply.code(err.httpStatus === 409 ? 409 : 503).send({ error: message });
      }
      req.log.error({ err: (err as Error).message }, "applicant start failed");
      return reply.code(503).send({ error: "The interview could not start. Please try again in a minute." });
    }
  });

  app.post<{ Params: { token: string } }>("/api/applicant/:token/end", async (req, reply) => {
    const invite = await findInvite(req.params.token);
    if (!invite) return gone(reply);
    const s = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM sessions WHERE invite_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [invite.id],
    );
    if (s.rows[0]) await endInterviewSession(ctx, s.rows[0].id, "ended_by_applicant");
    await ctx.pool.query("UPDATE invites SET status = 'completed' WHERE id = $1 AND status = 'started'", [invite.id]);
    return { ok: true };
  });

  app.post<{ Params: { token: string } }>("/api/applicant/:token/human-request", async (req, reply) => {
    const invite = await findInvite(req.params.token);
    if (!invite || invite.status === "revoked" || (invite.expired && invite.status === "pending")) return gone(reply);
    const r = await ctx.pool.query("UPDATE invites SET status = 'human_requested' WHERE id = $1 AND status = 'pending'", [
      invite.id,
    ]);
    if (!r.rowCount && invite.status !== "human_requested") {
      return reply.code(409).send({ error: "This link has already been used." });
    }
    await audit(ctx, { actorType: "applicant", action: "invite.human_request", targetType: "invite", targetId: invite.id });
    return { ok: true };
  });
}
