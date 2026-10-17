import type { InterviewScript } from "./script.js";

/**
 * Interview state is DERIVED from the full message history on every LLM call.
 * Nothing is committed during speculative or cancelled calls, so an interrupted
 * reply or a repeated speculative request can never corrupt the question position.
 */

export type NextAction =
  | "ready_check" // no answer yet; confirm the applicant is ready
  | "ask_first" // applicant confirmed ready; ask question 1
  | "ask_core" // previous answer done; ask the next core question
  | "probe" // previous answer was thin; ask one follow-up tied to their words
  | "repeat" // applicant asked to repeat or rephrase
  | "wait" // applicant asked for a moment to think
  | "close"; // all questions done or time is up

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface InterviewState {
  /** -1 = readiness check, 0..n-1 = question index, n = finished. */
  questionIndex: number;
  phase: "core" | "probe";
  probesUsed: number;
  nextAction: NextAction;
  userTurns: number;
}

const REPEAT_RE =
  /\b(repeat|say that again|come again|pardon|didn'?t (catch|hear|get) (that|it|you)|rephrase|what was the question|can you clarify the question|sorry\?)\b/i;
const WAIT_RE =
  /\b(give me a (moment|second|minute|sec)|let me think|one (moment|second|sec)|hold on|wait a (moment|second|sec)|just a (moment|second|sec))\b/i;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function classify(text: string): "repeat" | "wait" | "answer" {
  const words = wordCount(text);
  // Only short utterances count as control requests; a long answer that happens
  // to contain "let me think" is still an answer.
  if (words <= 12 && REPEAT_RE.test(text)) return "repeat";
  if (words <= 12 && WAIT_RE.test(text)) return "wait";
  return "answer";
}

export function deriveState(
  messages: ChatMessage[],
  script: InterviewScript,
  opts: { timeUp?: boolean } = {},
): InterviewState {
  const total = script.questions.length;
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter((t) => t.length > 0);

  let questionIndex = -1;
  let phase: "core" | "probe" = "core";
  let probesUsed = 0;
  let nextAction: NextAction = "ready_check";

  for (const text of userTexts) {
    const kind = classify(text);
    if (kind === "repeat") {
      nextAction = "repeat";
      continue;
    }
    if (kind === "wait") {
      nextAction = "wait";
      continue;
    }

    if (questionIndex === -1) {
      // Any substantive reply to the greeting starts question 1.
      questionIndex = 0;
      phase = "core";
      probesUsed = 0;
      nextAction = "ask_first";
      continue;
    }

    if (questionIndex >= total) {
      nextAction = "close";
      continue;
    }

    const thin = wordCount(text) < script.thinAnswerWords;
    if (phase === "core" && thin && probesUsed < script.maxProbesPerQuestion) {
      phase = "probe";
      probesUsed += 1;
      nextAction = "probe";
    } else {
      questionIndex += 1;
      phase = "core";
      probesUsed = 0;
      nextAction = questionIndex >= total ? "close" : "ask_core";
    }
  }

  if (opts.timeUp) nextAction = "close";

  return { questionIndex, phase, probesUsed, nextAction, userTurns: userTexts.length };
}
