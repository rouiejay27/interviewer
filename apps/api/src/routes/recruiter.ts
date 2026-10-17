import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AttemptLimiter,
  audit,
  COOKIE_NAME,
  newToken,
  readCookie,
  requireRecruiter,
  sessionCookie,
  verifyPassword,
} from "../auth.js";
import { sha256, type AppContext } from "../context.js";
import { endInterviewSession } from "../interview/start.js";
import { draftRubric, questionsForCall } from "../rubric/draft.js";
import { EXAMPLE_RUBRIC, Rubric, rubricErrors } from "../rubric/rubric.js";
import { buildReport } from "../evaluation/report.js";
import { queueEvaluation } from "../evaluation/runner.js";

const UUID = z.uuid();
const IdParams = z.object({ id: UUID });

const Login = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().min(1).max(200) });
const NewVacancy = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().min(20, "Add a job description of at least a few sentences.").max(8000),
  objectives: z.string().trim().max(2000).default(""),
});
const RubricBody = z.object({ content: z.unknown() });
const NewInvite = z.object({
  candidateLabel: z.string().trim().min(1).max(80),
});
const NewDecision = z.object({
  decision: z.enum(["advance", "hold", "decline", "undecided"]),
  notes: z.string().trim().max(4000).default(""),
});

// A dummy hash so unknown emails take as long as wrong passwords.
const DUMMY_HASH = "scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function registerRecruiterRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Limit by IP and by account, so a spoofed forwarding header cannot bypass the account limit.
  const ipLimiter = new AttemptLimiter(50, 15 * 60_000);
  const accountLimiter = new AttemptLimiter(10, 15 * 60_000);
  const auth = { preHandler: requireRecruiter(ctx) };

  function bad(reply: FastifyReply, error: string, details?: string[]) {
    return reply.code(400).send({ error, details });
  }

  /** Loads a vacancy only if the logged-in recruiter owns it. Others get 404, not 403. */
  async function ownedVacancy(vacancyId: string, recruiterId: string) {
    const r = await ctx.pool.query<{ id: string; title: string; description: string; objectives: string; created_at: Date }>(
      "SELECT id, title, description, objectives, created_at FROM vacancies WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL",
      [vacancyId, recruiterId],
    );
    return r.rows[0];
  }

  async function ownedRubric(rubricId: string, recruiterId: string) {
    const r = await ctx.pool.query<{ id: string; vacancy_id: string; status: string; content: unknown; version: number }>(
      `SELECT rv.id, rv.vacancy_id, rv.status, rv.content, rv.version FROM rubric_versions rv
       JOIN vacancies v ON v.id = rv.vacancy_id WHERE rv.id = $1 AND v.owner_id = $2`,
      [rubricId, recruiterId],
    );
    return r.rows[0];
  }

  async function ownedSession(sessionId: string, recruiterId: string) {
    const r = await ctx.pool.query<{ id: string; vacancy_id: string }>(
      `SELECT s.id, i.vacancy_id FROM sessions s
       JOIN invites i ON i.id = s.invite_id JOIN vacancies v ON v.id = i.vacancy_id
       WHERE s.id = $1 AND v.owner_id = $2`,
      [sessionId, recruiterId],
    );
    return r.rows[0];
  }

  // ---------- login ----------

  app.post("/api/auth/login", async (req, reply) => {
    const body = Login.safeParse(req.body);
    if (!body.success) return bad(reply, "Enter your email and password.");
    if (!ipLimiter.allow(req.ip) || !accountLimiter.allow(body.data.email)) {
      return reply.code(429).send({ error: "Too many attempts. Wait 15 minutes." });
    }
    const row = await ctx.pool.query<{ id: string; password_hash: string }>(
      "SELECT id, password_hash FROM recruiters WHERE email = $1",
      [body.data.email],
    );
    const rec = row.rows[0];
    const ok = await verifyPassword(body.data.password, rec?.password_hash ?? DUMMY_HASH);
    if (!rec || !ok) return reply.code(401).send({ error: "Wrong email or password." });

    const token = newToken();
    const hours = ctx.config.RECRUITER_SESSION_HOURS;
    await ctx.pool.query(
      "INSERT INTO recruiter_sessions (token_hash, recruiter_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))",
      [sha256(token), rec.id, hours],
    );
    await ctx.pool.query("DELETE FROM recruiter_sessions WHERE expires_at < now()");
    await audit(ctx, { actorType: "recruiter", actorId: rec.id, action: "login" });
    reply.header("set-cookie", sessionCookie(req, token, hours * 3600));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = readCookie(req, COOKIE_NAME);
    if (token) await ctx.pool.query("DELETE FROM recruiter_sessions WHERE token_hash = $1", [sha256(token)]);
    reply.header("set-cookie", sessionCookie(req, "", 0));
    return { ok: true };
  });

  app.get("/api/auth/me", auth, async (req) => ({ recruiter: req.recruiter }));

  // ---------- vacancies ----------

  app.get("/api/vacancies", auth, async (req) => {
    const r = await ctx.pool.query(
      `SELECT v.id, v.title, v.created_at,
         (SELECT max(version) FROM rubric_versions WHERE vacancy_id = v.id AND status = 'approved') AS approved_version,
         (SELECT count(*)::int FROM invites WHERE vacancy_id = v.id) AS invites
       FROM vacancies v WHERE v.owner_id = $1 AND v.archived_at IS NULL ORDER BY v.created_at DESC`,
      [req.recruiter!.id],
    );
    return { vacancies: r.rows };
  });

  app.post("/api/vacancies", auth, async (req, reply) => {
    const body = NewVacancy.safeParse(req.body);
    if (!body.success) return bad(reply, "Check the vacancy fields.", body.error.issues.map((i) => i.message));
    const id = randomUUID();
    await ctx.pool.query(
      "INSERT INTO vacancies (id, owner_id, title, description, objectives) VALUES ($1, $2, $3, $4, $5)",
      [id, req.recruiter!.id, body.data.title, body.data.description, body.data.objectives],
    );
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "vacancy.create", targetType: "vacancy", targetId: id });
    return { id };
  });

  app.get("/api/vacancies/:id", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    const vacancy = await ownedVacancy(p.data.id, req.recruiter!.id);
    if (!vacancy) return reply.code(404).send({ error: "Not found." });
    const [rubrics, invites, interviews] = await Promise.all([
      ctx.pool.query(
        `SELECT id, version, status, source, content, created_at, approved_at FROM rubric_versions
         WHERE vacancy_id = $1 ORDER BY version DESC`,
        [vacancy.id],
      ),
      ctx.pool.query(
        `SELECT i.id, i.candidate_label, i.status, i.expires_at, i.created_at, i.started_at, rv.version AS rubric_version,
           (i.expires_at < now() AND i.status = 'pending') AS expired
         FROM invites i JOIN rubric_versions rv ON rv.id = i.rubric_version_id
         WHERE i.vacancy_id = $1 ORDER BY i.created_at DESC`,
        [vacancy.id],
      ),
      ctx.pool.query(
        `SELECT s.id, s.status, s.end_reason, s.created_at, s.ended_at, i.candidate_label,
           e.status AS evaluation_status,
           (SELECT decision FROM decisions d WHERE d.session_id = s.id ORDER BY d.id DESC LIMIT 1) AS decision,
           EXISTS (SELECT 1 FROM transcripts t WHERE t.session_id = s.id) AS has_transcript
         FROM sessions s JOIN invites i ON i.id = s.invite_id
         LEFT JOIN evaluations e ON e.session_id = s.id
         WHERE i.vacancy_id = $1 ORDER BY s.created_at DESC`,
        [vacancy.id],
      ),
    ]);
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "vacancy.view", targetType: "vacancy", targetId: vacancy.id });
    return {
      vacancy,
      rubrics: rubrics.rows,
      invites: invites.rows,
      interviews: interviews.rows,
      suggestedQuestions: questionsForCall(ctx.config.MAX_CALL_SECONDS),
      maxCallSeconds: ctx.config.MAX_CALL_SECONDS,
      exampleRubric: EXAMPLE_RUBRIC,
    };
  });

  // ---------- rubrics ----------

  /** Adds the next version number; retries if two saves race for the same number. */
  async function insertVersion(vacancyId: string, source: "ai_draft" | "manual", content: unknown) {
    for (let attempt = 0; ; attempt++) {
      const id = randomUUID();
      try {
        const r = await ctx.pool.query<{ version: number }>(
          `INSERT INTO rubric_versions (id, vacancy_id, version, source, content)
           SELECT $1, $2, COALESCE(max(version), 0) + 1, $3, $4 FROM rubric_versions WHERE vacancy_id = $2
           RETURNING version`,
          [id, vacancyId, source, JSON.stringify(content)],
        );
        return { id, version: r.rows[0]!.version };
      } catch (err) {
        if ((err as { code?: string }).code !== "23505" || attempt >= 2) throw err;
      }
    }
  }

  function validationOf(content: unknown): string[] {
    const parsed = Rubric.safeParse(content);
    return parsed.success ? [] : rubricErrors(parsed.error);
  }

  app.post("/api/vacancies/:id/rubrics/ai-draft", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    const vacancy = await ownedVacancy(p.data.id, req.recruiter!.id);
    if (!vacancy) return reply.code(404).send({ error: "Not found." });
    let content: unknown;
    try {
      content = await draftRubric(ctx.config, {
        title: vacancy.title,
        description: vacancy.description,
        objectives: vacancy.objectives,
        maxQuestions: questionsForCall(ctx.config.MAX_CALL_SECONDS),
      });
    } catch (err) {
      req.log.error({ err: (err as Error).message }, "rubric draft failed");
      return reply.code(502).send({ error: "The AI could not draft a rubric right now. Try again or write one by hand." });
    }
    const { id, version } = await insertVersion(vacancy.id, "ai_draft", content);
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "rubric.ai_draft", targetType: "rubric", targetId: id });
    return { id, version, errors: validationOf(content) };
  });

  app.post("/api/vacancies/:id/rubrics", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const body = RubricBody.safeParse(req.body);
    if (!p.success || !body.success) return reply.code(404).send({ error: "Not found." });
    const vacancy = await ownedVacancy(p.data.id, req.recruiter!.id);
    if (!vacancy) return reply.code(404).send({ error: "Not found." });
    if (!body.data.content || typeof body.data.content !== "object") return bad(reply, "The rubric must be a JSON object.");
    const { id, version } = await insertVersion(vacancy.id, "manual", body.data.content);
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "rubric.create", targetType: "rubric", targetId: id });
    return { id, version, errors: validationOf(body.data.content) };
  });

  app.put("/api/rubrics/:id", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const body = RubricBody.safeParse(req.body);
    if (!p.success || !body.success) return reply.code(404).send({ error: "Not found." });
    const rubric = await ownedRubric(p.data.id, req.recruiter!.id);
    if (!rubric) return reply.code(404).send({ error: "Not found." });
    if (rubric.status !== "draft") return reply.code(409).send({ error: "Approved rubrics are frozen. Create a new version instead." });
    if (!body.data.content || typeof body.data.content !== "object") return bad(reply, "The rubric must be a JSON object.");
    const updated = await ctx.pool.query("UPDATE rubric_versions SET content = $2 WHERE id = $1 AND status = 'draft'", [
      rubric.id,
      JSON.stringify(body.data.content),
    ]);
    if (!updated.rowCount) return reply.code(409).send({ error: "This version was approved in the meantime. Reload the page." });
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "rubric.edit", targetType: "rubric", targetId: rubric.id });
    return { ok: true, errors: validationOf(body.data.content) };
  });

  app.post("/api/rubrics/:id/approve", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    const rubric = await ownedRubric(p.data.id, req.recruiter!.id);
    if (!rubric) return reply.code(404).send({ error: "Not found." });
    if (rubric.status !== "draft") return reply.code(409).send({ error: "This version is already approved." });
    const parsed = Rubric.safeParse(rubric.content);
    if (!parsed.success) return bad(reply, "Fix these problems before approving.", rubricErrors(parsed.error));
    // Store the normalized rubric (defaults filled in) so what was approved is exactly what runs.
    await ctx.pool.query(
      `UPDATE rubric_versions SET status = 'approved', content = $2, approved_at = now(), approved_by = $3
       WHERE id = $1 AND status = 'draft'`,
      [rubric.id, JSON.stringify(parsed.data), req.recruiter!.id],
    );
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "rubric.approve", targetType: "rubric", targetId: rubric.id });
    return { ok: true };
  });

  // ---------- applicant links ----------

  app.post("/api/vacancies/:id/invites", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const body = NewInvite.safeParse(req.body);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    if (!body.success) return bad(reply, "Enter a label for the applicant (for example a reference number).");
    const vacancy = await ownedVacancy(p.data.id, req.recruiter!.id);
    if (!vacancy) return reply.code(404).send({ error: "Not found." });
    const approved = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM rubric_versions WHERE vacancy_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1",
      [vacancy.id],
    );
    const rubricId = approved.rows[0]?.id;
    if (!rubricId) return reply.code(409).send({ error: "Approve a rubric before inviting applicants." });

    const id = randomUUID();
    const token = newToken();
    await ctx.pool.query(
      `INSERT INTO invites (id, vacancy_id, rubric_version_id, candidate_label, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), $7)`,
      [id, vacancy.id, rubricId, body.data.candidateLabel, sha256(token), ctx.config.INVITE_TTL_HOURS, req.recruiter!.id],
    );
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "invite.create", targetType: "invite", targetId: id });
    // The full link is shown once. Only its hash is stored.
    return { id, link: `${ctx.config.PUBLIC_BASE_URL}/i/${token}`, expiresInHours: ctx.config.INVITE_TTL_HOURS };
  });

  // A new one-time link for the same applicant (after a dropped call, or after they asked for a person).
  app.post("/api/invites/:id/reissue", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    const old = await ctx.pool.query<{ id: string; vacancy_id: string; candidate_label: string; status: string }>(
      `SELECT i.id, i.vacancy_id, i.candidate_label, i.status FROM invites i JOIN vacancies v ON v.id = i.vacancy_id
       WHERE i.id = $1 AND v.owner_id = $2`,
      [p.data.id, req.recruiter!.id],
    );
    const o = old.rows[0];
    if (!o) return reply.code(404).send({ error: "Not found." });
    const approved = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM rubric_versions WHERE vacancy_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1",
      [o.vacancy_id],
    );
    const id = randomUUID();
    const token = newToken();
    await ctx.pool.query("UPDATE invites SET status = 'revoked' WHERE id = $1 AND status IN ('pending', 'human_requested')", [o.id]);
    await ctx.pool.query(
      `INSERT INTO invites (id, vacancy_id, rubric_version_id, candidate_label, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), $7)`,
      [id, o.vacancy_id, approved.rows[0]!.id, o.candidate_label, sha256(token), ctx.config.INVITE_TTL_HOURS, req.recruiter!.id],
    );
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "invite.reissue", targetType: "invite", targetId: id });
    return { id, link: `${ctx.config.PUBLIC_BASE_URL}/i/${token}`, expiresInHours: ctx.config.INVITE_TTL_HOURS };
  });

  app.post("/api/invites/:id/revoke", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    const r = await ctx.pool.query(
      `UPDATE invites i SET status = 'revoked' FROM vacancies v
       WHERE i.id = $1 AND v.id = i.vacancy_id AND v.owner_id = $2 AND i.status IN ('pending', 'human_requested')`,
      [p.data.id, req.recruiter!.id],
    );
    if (!r.rowCount) return reply.code(409).send({ error: "This link cannot be revoked (not found, or already used)." });
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "invite.revoke", targetType: "invite", targetId: p.data.id });
    return { ok: true };
  });

  // ---------- interviews and reports ----------

  app.get("/api/interviews/:id/report", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    const owned = await ownedSession(p.data.id, req.recruiter!.id);
    if (!owned) return reply.code(404).send({ error: "Not found." });
    const report = await buildReport(ctx, owned.id);
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "report.view", targetType: "session", targetId: owned.id });
    return report;
  });

  // Light status check for the report page's polling (no audit row per poll).
  app.get("/api/interviews/:id/status", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    const owned = await ownedSession(p.data.id, req.recruiter!.id);
    if (!owned) return reply.code(404).send({ error: "Not found." });
    const r = await ctx.pool.query(
      `SELECT s.status, EXISTS (SELECT 1 FROM transcripts t WHERE t.session_id = s.id) AS has_transcript,
         e.status AS evaluation_status, e.updated_at AS evaluation_updated_at
       FROM sessions s LEFT JOIN evaluations e ON e.session_id = s.id WHERE s.id = $1`,
      [owned.id],
    );
    return r.rows[0];
  });

  app.post("/api/interviews/:id/evaluate", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    const owned = await ownedSession(p.data.id, req.recruiter!.id);
    if (!owned) return reply.code(404).send({ error: "Not found." });
    const t = await ctx.pool.query("SELECT 1 FROM transcripts WHERE session_id = $1", [owned.id]);
    if (!t.rowCount) return reply.code(409).send({ error: "The transcript has not arrived yet." });
    await queueEvaluation(ctx, owned.id, { reset: true, log: req.log });
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "evaluation.rerun", targetType: "session", targetId: owned.id });
    return { ok: true };
  });

  app.post("/api/interviews/:id/decisions", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const body = NewDecision.safeParse(req.body);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    if (!body.success) return bad(reply, "Choose a decision.");
    const owned = await ownedSession(p.data.id, req.recruiter!.id);
    if (!owned) return reply.code(404).send({ error: "Not found." });
    await ctx.pool.query("INSERT INTO decisions (session_id, recruiter_id, decision, notes) VALUES ($1, $2, $3, $4)", [
      owned.id,
      req.recruiter!.id,
      body.data.decision,
      body.data.notes,
    ]);
    await audit(ctx, { actorType: "recruiter", actorId: req.recruiter!.id, action: "decision.record", targetType: "session", targetId: owned.id });
    return { ok: true };
  });

  app.post("/api/interviews/:id/end", auth, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "Not found." });
    const owned = await ownedSession(p.data.id, req.recruiter!.id);
    if (!owned) return reply.code(404).send({ error: "Not found." });
    if (!(await endInterviewSession(ctx, owned.id, "ended_by_recruiter"))) {
      return reply.code(502).send({ error: "The provider did not confirm. The cleanup job will retry." });
    }
    return { ok: true };
  });
}
