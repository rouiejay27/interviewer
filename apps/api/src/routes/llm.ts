import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { safeEqual, sha256, type AppContext } from "../context.js";
import { buildLlmMessages, buildSystemPrompt } from "../interview/prompt.js";
import { POC_SCRIPT } from "../interview/script.js";
import { deriveState, type ChatMessage } from "../interview/state.js";
import { extractDeltaText, streamChat } from "../llm/grok.js";

const ContentPart = z.object({ type: z.string(), text: z.string().optional() }).loose();
const IncomingMessage = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool", "developer"]),
    content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
  })
  .loose();
const ChatRequest = z
  .object({
    model: z.string().optional(),
    messages: z.array(IncomingMessage).min(1),
    stream: z.boolean().optional(),
  })
  .loose();

const SESSION_RE = /INTERVIEWER_SESSION_ID=([0-9a-f-]{36})/i;
const FALLBACK_TEXT = "Sorry, I had a brief technical issue on my side. Could you please say that again?";

function toText(content: z.infer<typeof IncomingMessage>["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("");
  return "";
}

function bearerOrKey(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers["x-api-key"];
  return typeof key === "string" ? key : undefined;
}

function sseChunk(id: string, model: string, content: string | null, finish: string | null): string {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: content === null ? {} : { role: "assistant", content }, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function registerLlmRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * OpenAI-compatible endpoint that Tavus calls as the PAL's custom LLM.
   * Tavus appends /chat/completions to the base URL we register: PUBLIC_BASE_URL/llm/v1
   */
  app.post("/llm/v1/chat/completions", async (req, reply) => {
    if (!safeEqual(bearerOrKey(req), ctx.config.LLM_PROXY_SECRET)) {
      req.log.warn("custom LLM call rejected: bad or missing credential");
      return reply.code(401).send({ error: { message: "unauthorized" } });
    }

    const parsed = ChatRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "invalid chat completion request" } });
    }

    const history: ChatMessage[] = parsed.data.messages.map((m) => ({
      role: m.role === "developer" ? "system" : m.role,
      content: toText(m.content),
    }));

    // Map this request to our session (marker comes from conversational_context).
    const marker = history
      .filter((m) => m.role === "system")
      .map((m) => SESSION_RE.exec(m.content)?.[1])
      .find(Boolean);
    const sessionRow = await ctx.pool.query<{ id: string; created_at: Date; max_call_seconds: number }>(
      marker
        ? "SELECT id, created_at, max_call_seconds FROM sessions WHERE id = $1"
        : "SELECT id, created_at, max_call_seconds FROM sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1",
      marker ? [marker] : [],
    );
    const session = sessionRow.rows[0];
    if (!marker) req.log.warn({ found: Boolean(session) }, "no session marker in LLM request; used latest active session");

    // Close politely 30 seconds before the provider's hard cap.
    const timeUp = session
      ? Date.now() > session.created_at.getTime() + (session.max_call_seconds - 30) * 1000
      : false;
    const state = deriveState(history, POC_SCRIPT, { timeUp });
    const system = buildSystemPrompt(POC_SCRIPT, state);
    const llmMessages = buildLlmMessages(system, history);

    const lastUser = [...history].reverse().find((m) => m.role === "user" && m.content.trim());
    if (session && lastUser) {
      await ctx.pool.query(
        `INSERT INTO turn_log (session_id, role, content, content_hash, next_action)
         VALUES ($1, 'user', $2, $3, $4) ON CONFLICT DO NOTHING`,
        [session.id, lastUser.content, sha256(lastUser.content), state.nextAction],
      );
    }
    req.log.info(
      { sessionId: session?.id, q: state.questionIndex, action: state.nextAction, userTurns: state.userTurns },
      "custom LLM turn",
    );

    const model = parsed.data.model ?? "interviewer-poc";
    const completionId = `chatcmpl-${Date.now().toString(36)}`;
    const abort = new AbortController();
    let finished = false;
    // If Tavus drops the connection (applicant barged in), stop generating right away.
    // Listen on the response, not the request: a request emits "close" as soon as its body is read.
    reply.raw.on("close", () => {
      if (!finished) abort.abort();
    });

    const started = performance.now();
    let firstTokenMs: number | null = null;
    let spoken = "";

    reply.hijack();
    const out = reply.raw;
    out.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    try {
      const upstream = await streamChat({
        baseUrl: ctx.config.XAI_BASE_URL,
        apiKey: ctx.config.XAI_API_KEY,
        model: ctx.config.XAI_LIVE_MODEL,
        messages: llmMessages,
        signal: abort.signal,
      });
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
        const text = decoder.decode(value, { stream: true });
        spoken += extractDeltaText(text);
        out.write(text);
      }
    } catch (err) {
      if (abort.signal.aborted) {
        req.log.info({ sessionId: session?.id }, "LLM stream cancelled (applicant interrupted or provider closed)");
      } else {
        req.log.error({ err: (err as Error).message }, "LLM upstream failed; sending fallback line");
        out.write(sseChunk(completionId, model, FALLBACK_TEXT, null));
        out.write(sseChunk(completionId, model, null, "stop"));
        out.write("data: [DONE]\n\n");
        spoken = FALLBACK_TEXT;
      }
    } finally {
      finished = true;
      if (!out.writableEnded) out.end();
    }

    if (session && spoken.trim() && !abort.signal.aborted) {
      await ctx.pool
        .query(
          `INSERT INTO turn_log (session_id, role, content, content_hash, next_action, first_token_ms)
           VALUES ($1, 'assistant', $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [session.id, spoken, sha256(spoken), state.nextAction, firstTokenMs],
        )
        .catch((e: Error) => req.log.error({ err: e.message }, "turn_log insert failed"));
    }
    req.log.info({ sessionId: session?.id, firstTokenMs, aborted: abort.signal.aborted }, "custom LLM turn done");
  });
}
