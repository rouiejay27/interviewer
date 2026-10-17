/**
 * Phase 1 PoC script. Fixed demo questions so the live-call checks are repeatable.
 * Phase 3 replaces this with a recruiter-approved, versioned rubric per vacancy.
 */
export interface ScriptQuestion {
  competency: string;
  core: string;
  /** Hint for the follow-up; the LLM must still tie it to the applicant's own words. */
  probeHint: string;
}

export interface InterviewScript {
  roleTitle: string;
  greeting: string;
  questions: ScriptQuestion[];
  maxProbesPerQuestion: number;
  /** Answers shorter than this (in words) get one follow-up probe. */
  thinAnswerWords: number;
}

export const POC_SCRIPT: InterviewScript = {
  roleTitle: "Junior IT Support Specialist (demo)",
  greeting:
    "Hi, thanks for joining. I'm the iNTERVIEWER AI, and a human recruiter will review this conversation. This is a short practice interview with three questions. Are you ready to begin?",
  questions: [
    {
      competency: "Troubleshooting",
      core: "Walk me through the last technical problem you fixed, step by step.",
      probeHint: "Ask what they checked first and why.",
    },
    {
      competency: "Customer communication",
      core: "Tell me about a time a user was frustrated with a tech issue. How did you handle it?",
      probeHint: "Ask what exactly they said to the user.",
    },
    {
      competency: "Prioritization",
      core: "Three support tickets arrive at the same time. How do you decide which one to handle first?",
      probeHint: "Ask what would make them change that order.",
    },
  ],
  maxProbesPerQuestion: 1,
  thinAnswerWords: 25,
};
