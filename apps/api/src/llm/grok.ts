/**
 * Streams an OpenAI-compatible chat completion from xAI (https://api.x.ai/v1).
 * The response is SSE in OpenAI chunk format, so it can be forwarded to Tavus as-is.
 */
export interface StreamChatInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  signal: AbortSignal;
  maxTokens?: number;
}

export async function streamChat(input: StreamChatInput): Promise<Response> {
  const res = await fetch(`${input.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      stream: true,
      temperature: 0.4,
      max_tokens: input.maxTokens ?? 160,
    }),
    signal: input.signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`xAI request failed with HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res;
}

/** Pulls assistant text out of OpenAI-style SSE lines, for logging the spoken reply. */
export function extractDeltaText(sseChunk: string): string {
  let out = "";
  for (const line of sseChunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
      out += json.choices?.[0]?.delta?.content ?? "";
    } catch {
      // Partial line split across network chunks; the caller only uses this for logs.
    }
  }
  return out;
}
