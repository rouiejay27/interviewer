import { z } from "zod";
import type { InterviewScript } from "../interview/script.js";

/**
 * A job-specific rubric. Recruiters approve it before any applicant is interviewed,
 * and the approved version is frozen so every applicant for the vacancy is assessed
 * against the same core criteria.
 */
const Id = z.string().regex(/^[a-z0-9_-]{1,40}$/, "use lowercase letters, numbers, - or _");

export const Criterion = z.object({
  id: Id,
  name: z.string().min(2).max(80),
  description: z.string().min(5).max(400),
  /** Relative importance, 1 (low) to 5 (high). */
  weight: z.number().int().min(1).max(5),
  /** What a 1, 3 and 5 answer looks like. 2 and 4 sit between them. */
  anchors: z.object({
    "1": z.string().min(5).max(300),
    "3": z.string().min(5).max(300),
    "5": z.string().min(5).max(300),
  }),
});

export const Question = z.object({
  id: Id,
  text: z.string().min(10).max(300),
  criterionIds: z.array(Id).min(1).max(3),
  probeHint: z.string().min(5).max(200),
});

export const Rubric = z
  .object({
    roleTitle: z.string().min(2).max(120),
    criteria: z.array(Criterion).min(1).max(8),
    questions: z.array(Question).min(1).max(8),
    thinAnswerWords: z.number().int().min(5).max(80).default(25),
    maxProbesPerQuestion: z.number().int().min(0).max(2).default(1),
  })
  .superRefine((r, ctx) => {
    const ids = new Set<string>();
    r.criteria.forEach((c, i) => {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", path: ["criteria", i, "id"], message: `duplicate criterion id "${c.id}"` });
      ids.add(c.id);
    });
    const qids = new Set<string>();
    r.questions.forEach((q, i) => {
      if (qids.has(q.id)) ctx.addIssue({ code: "custom", path: ["questions", i, "id"], message: `duplicate question id "${q.id}"` });
      qids.add(q.id);
      q.criterionIds.forEach((cid, j) => {
        if (!ids.has(cid))
          ctx.addIssue({ code: "custom", path: ["questions", i, "criterionIds", j], message: `unknown criterion "${cid}"` });
      });
    });
    const covered = new Set(r.questions.flatMap((q) => q.criterionIds));
    r.criteria.forEach((c, i) => {
      if (!covered.has(c.id))
        ctx.addIssue({ code: "custom", path: ["criteria", i], message: `no question covers "${c.name}"` });
    });
  });

export type Rubric = z.infer<typeof Rubric>;

/** Readable validation errors for the rubric editor. */
export function rubricErrors(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "rubric"}: ${i.message}`);
}

/** JSON Schema used for Grok structured output when drafting a rubric (xAI json_schema mode). */
export const RUBRIC_DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["roleTitle", "criteria", "questions"],
  properties: {
    roleTitle: { type: "string" },
    criteria: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "description", "weight", "anchors"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          weight: { type: "integer", minimum: 1, maximum: 5 },
          anchors: {
            type: "object",
            additionalProperties: false,
            required: ["1", "3", "5"],
            properties: { "1": { type: "string" }, "3": { type: "string" }, "5": { type: "string" } },
          },
        },
      },
    },
    questions: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "criterionIds", "probeHint"],
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          criterionIds: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
          probeHint: { type: "string" },
        },
      },
    },
  },
} as const;

export function greetingFor(rubric: Rubric): string {
  const n = rubric.questions.length;
  return (
    `Hi, thanks for joining. I'm an AI interviewer for the ${rubric.roleTitle} role. ` +
    `A human recruiter will review this conversation and make all decisions. ` +
    `I have ${n} question${n === 1 ? "" : "s"} for you. Are you ready to begin?`
  );
}

/** Converts an approved rubric into the script the live interview engine runs. */
export function scriptFromRubric(rubric: Rubric): InterviewScript {
  const names = new Map(rubric.criteria.map((c) => [c.id, c.name]));
  return {
    roleTitle: rubric.roleTitle,
    greeting: greetingFor(rubric),
    questions: rubric.questions.map((q) => ({
      competency: q.criterionIds.map((id) => names.get(id) ?? id).join(", "),
      core: q.text,
      probeHint: q.probeHint,
    })),
    maxProbesPerQuestion: rubric.maxProbesPerQuestion,
    thinAnswerWords: rubric.thinAnswerWords,
  };
}

/** Example rubric shown when a recruiter writes one by hand. Labeled as an example. */
export const EXAMPLE_RUBRIC: Rubric = {
  roleTitle: "Junior IT Support Specialist",
  criteria: [
    {
      id: "troubleshooting",
      name: "Troubleshooting",
      description: "Finds the cause of a technical problem in a logical order and confirms the fix.",
      weight: 3,
      anchors: {
        "1": "Guesses or restarts things with no clear order; cannot explain why.",
        "3": "Follows a sensible order of checks for a common problem; explains most steps.",
        "5": "Narrows the cause methodically, explains each check, and confirms the fix worked.",
      },
    },
    {
      id: "communication",
      name: "User communication",
      description: "Explains technical issues to non-technical users clearly and calmly.",
      weight: 2,
      anchors: {
        "1": "Uses jargon or dismisses the user's concern.",
        "3": "Explains the issue in plain words and keeps the user informed.",
        "5": "Adjusts the explanation to the user, sets expectations, and confirms the user is satisfied.",
      },
    },
  ],
  questions: [
    {
      id: "q1",
      text: "Walk me through the last technical problem you fixed, step by step.",
      criterionIds: ["troubleshooting"],
      probeHint: "Ask what they checked first and why.",
    },
    {
      id: "q2",
      text: "Tell me about a time a user was frustrated with a tech issue. How did you handle it?",
      criterionIds: ["communication"],
      probeHint: "Ask what exactly they said to the user.",
    },
  ],
  thinAnswerWords: 25,
  maxProbesPerQuestion: 1,
};
