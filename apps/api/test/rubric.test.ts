import { describe, expect, it } from "vitest";
import { deriveState } from "../src/interview/state.js";
import { EXAMPLE_RUBRIC, greetingFor, Rubric, rubricErrors, scriptFromRubric } from "../src/rubric/rubric.js";
import { questionsForCall } from "../src/rubric/draft.js";

const clone = () => structuredClone(EXAMPLE_RUBRIC);

describe("rubric validation", () => {
  it("accepts the example rubric", () => {
    expect(Rubric.safeParse(EXAMPLE_RUBRIC).success).toBe(true);
  });

  it("fills defaults for thin-answer settings", () => {
    const { thinAnswerWords, maxProbesPerQuestion, ...rest } = clone();
    const parsed = Rubric.parse(rest);
    expect(parsed.thinAnswerWords).toBe(25);
    expect(parsed.maxProbesPerQuestion).toBe(1);
    void thinAnswerWords; void maxProbesPerQuestion;
  });

  it("rejects a question that points to an unknown criterion", () => {
    const r = clone();
    r.questions[0]!.criterionIds = ["teamwork"];
    const res = Rubric.safeParse(r);
    expect(res.success).toBe(false);
    if (!res.success) expect(rubricErrors(res.error).join(" ")).toContain('unknown criterion "teamwork"');
  });

  it("rejects a criterion no question covers", () => {
    const r = clone();
    r.questions = [r.questions[0]!];
    const res = Rubric.safeParse(r);
    expect(res.success).toBe(false);
    if (!res.success) expect(rubricErrors(res.error).join(" ")).toContain("no question covers");
  });

  it("rejects duplicate ids and bad weights", () => {
    const r = clone();
    r.criteria[1]!.id = r.criteria[0]!.id;
    r.criteria[0]!.weight = 9;
    expect(Rubric.safeParse(r).success).toBe(false);
  });
});

describe("script from rubric", () => {
  it("runs the approved questions in order with criterion names as competencies", () => {
    const script = scriptFromRubric(EXAMPLE_RUBRIC);
    expect(script.questions.map((q) => q.core)).toEqual(EXAMPLE_RUBRIC.questions.map((q) => q.text));
    expect(script.questions[0]!.competency).toBe("Troubleshooting");
    expect(script.greeting).toContain("AI interviewer");
    expect(script.greeting).toContain("2 questions");
  });

  it("drives the same state machine as the Phase 1 script", () => {
    const script = scriptFromRubric(EXAMPLE_RUBRIC);
    const long = "I checked the cable first, then the switch port lights, then I pinged the gateway and found the DHCP lease had expired so I renewed it and confirmed the user could browse again.";
    const s = deriveState(
      [
        { role: "user", content: "Yes, ready." },
        { role: "user", content: long },
        { role: "user", content: long },
      ],
      script,
    );
    expect(s.nextAction).toBe("close");
  });

  it("greeting grammar for one question", () => {
    const r = clone();
    r.criteria = [r.criteria[0]!];
    r.questions = [r.questions[0]!];
    expect(greetingFor(Rubric.parse(r))).toContain("1 question for you");
  });

  it("fits about 3 questions in the free-plan 5 minute call", () => {
    expect(questionsForCall(290)).toBe(3);
    expect(questionsForCall(600)).toBe(6);
    expect(questionsForCall(120)).toBe(2);
  });
});
