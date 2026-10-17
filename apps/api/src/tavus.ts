/**
 * Minimal Tavus CVI client. Endpoints and fields follow the official API reference
 * (docs.tavus.io, checked 2026-10-17): POST /v2/pals, POST /v2/conversations,
 * POST /v2/conversations/{id}/end. Auth header: x-api-key.
 */
export interface TavusAuth {
  apiKey: string;
  /** Defaults to https://tavusapi.com; overridable only for local tests. */
  baseUrl: string;
}

export class TavusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

async function tavusFetch<T>(auth: TavusAuth, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${auth.baseUrl}${path}`, {
    method: "POST",
    headers: { "x-api-key": auth.apiKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new TavusError(`Tavus ${path} failed with HTTP ${res.status}`, res.status, text.slice(0, 500));
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface CreatePalInput {
  palName: string;
  faceId: string;
  llmBaseUrl: string;
  llmApiKey: string;
}

export async function createPal(auth: TavusAuth, input: CreatePalInput): Promise<{ pal_id: string }> {
  return tavusFetch(auth, "/v2/pals", {
    pal_name: input.palName,
    pipeline_mode: "full",
    default_face_id: input.faceId,
    // Placeholder only: the real interview instructions are built per turn by our endpoint.
    system_prompt: "You are an interviewer. Follow the instructions supplied with each request.",
    languages: ["en"],
    disclosure_type: "always",
    verbal_disclosure: "Just so you know, I am an AI interviewer, not a person.",
    visual_disclosure: "You are speaking with an AI interviewer. A human recruiter makes all decisions.",
    layers: {
      llm: {
        model: "interviewer-poc",
        base_url: input.llmBaseUrl,
        api_key: input.llmApiKey,
        speculative_inference: true,
      },
      // No face, emotion, or voice-tone analysis. Never used for evaluation.
      perception: { perception_model: "off" },
      stt: { stt_engine: "tavus-auto" },
      conversational_flow: {
        turn_detection_model: "sparrow-2",
        turn_taking_patience: "high", // interview answers have natural thinking pauses
        pal_interruptibility: "high", // stop talking quickly when the applicant speaks
        idle_engagement: "off",
      },
    },
  });
}

export interface CreateConversationInput {
  palId: string;
  sessionId: string;
  /** Shown in the provider dashboard. Never include applicant names. */
  conversationName?: string;
  callbackUrl: string;
  greeting: string;
  maxCallSeconds: number;
  testMode: boolean;
}

export interface CreateConversationResult {
  conversation_id: string;
  conversation_url: string;
  status: string;
  meeting_token?: string;
}

export async function createConversation(
  auth: TavusAuth,
  input: CreateConversationInput,
): Promise<CreateConversationResult> {
  return tavusFetch(auth, "/v2/conversations", {
    pal_id: input.palId,
    conversation_name: input.conversationName ?? `iNTERVIEWER PoC ${input.sessionId.slice(0, 8)}`,
    // Lets our custom LLM endpoint map each request to the right session.
    conversational_context: `INTERVIEWER_SESSION_ID=${input.sessionId}`,
    custom_greeting: input.greeting,
    callback_url: input.callbackUrl,
    require_auth: true,
    max_participants: 2,
    test_mode: input.testMode,
    properties: {
      max_call_duration: input.maxCallSeconds,
      participant_left_timeout: 60,
      participant_absent_timeout: 120,
      enable_closed_captions: true,
      enable_recording: false,
      languages: ["en"],
    },
  });
}

export async function endConversation(auth: TavusAuth, conversationId: string): Promise<void> {
  await tavusFetch(auth, `/v2/conversations/${encodeURIComponent(conversationId)}/end`);
}
