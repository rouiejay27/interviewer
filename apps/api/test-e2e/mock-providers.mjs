// MOCK Tavus and xAI servers for local end-to-end tests ONLY.
// Nothing here talks to a real provider, and passing tests do not prove the real integrations work.
import http from "node:http";

const port = Number(process.env.MOCK_PORT || 4100);
const seen = { tavus: [], xaiStream: [], xaiJson: [], aborted: 0 };
let failNextJson = false;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function rubricDraft() {
  return {
    roleTitle: "Help Desk Analyst",
    criteria: [
      {
        id: "troubleshooting",
        name: "Troubleshooting",
        description: "Finds the cause of a problem in a logical order and confirms the fix.",
        weight: 3,
        anchors: { 1: "No clear order of checks.", 3: "Sensible checks for a common problem.", 5: "Methodical, explains each check, confirms the fix." },
      },
      {
        id: "communication",
        name: "User communication",
        description: "Explains issues to non-technical users clearly.",
        weight: 2,
        anchors: { 1: "Uses jargon or dismisses the user.", 3: "Plain explanation, keeps the user informed.", 5: "Adapts to the user and confirms satisfaction." },
      },
    ],
    questions: [
      { id: "q1", text: "Walk me through the last technical problem you fixed, step by step.", criterionIds: ["troubleshooting"], probeHint: "Ask what they checked first." },
      { id: "q2", text: "Tell me about a time you explained a technical issue to a frustrated user.", criterionIds: ["communication"], probeHint: "Ask what exactly they said." },
    ],
  };
}

/** Builds a deterministic evaluation from the transcript in the prompt: one real quote, one invented. */
function evaluation(userPrompt) {
  const applicant = [...userPrompt.matchAll(/^\[(\d+)\] APPLICANT: (.*)$/gm)].map((m) => ({ entry: Number(m[1]), text: m[2] }));
  const longest = applicant.sort((a, b) => b.text.length - a.text.length)[0];
  const quote = longest ? longest.text.split(" ").slice(0, 5).join(" ") : "";
  return {
    criteria: [
      { criterionId: "troubleshooting", rating: 4, evidence: longest ? [{ entry: longest.entry, quote }] : [], rationale: "Applicant described ordered checks." },
      // Invented quote: the server must drop it and mark the criterion Not assessed.
      { criterionId: "communication", rating: 5, evidence: [{ entry: longest?.entry ?? 0, quote: "I always calm every user down perfectly" }], rationale: "Made up." },
    ],
    unresolved: ["No example of explaining an issue to a frustrated user."],
  };
}

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const json = raw ? JSON.parse(raw) : {};

  if (req.url === "/__seen") return send(res, 200, seen);
  if (req.url === "/__fail-next-json") { failNextJson = true; return send(res, 200, { ok: true }); }

  if (req.url?.startsWith("/v2/")) {
    seen.tavus.push({ path: req.url, key: req.headers["x-api-key"], body: json });
    if (req.url === "/v2/conversations") {
      return send(res, 200, { conversation_id: "cMOCK" + seen.tavus.length, conversation_url: "https://tavus.daily.co/cMOCK", status: "active", meeting_token: "tok123" });
    }
    if (req.url === "/v2/pals") return send(res, 200, { pal_id: "pMOCK1" });
    return send(res, 200, {});
  }

  if (req.url === "/v1/chat/completions" && json.stream === false) {
    const name = json.response_format?.json_schema?.name;
    seen.xaiJson.push({ auth: req.headers.authorization, model: json.model, name, messages: json.messages, response_format: json.response_format });
    if (failNextJson) { failNextJson = false; res.writeHead(500); return res.end("mock failure"); }
    const content = name === "interview_rubric" ? rubricDraft() : evaluation(json.messages.at(-1).content);
    return send(res, 200, { id: "x", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }

  if (req.url === "/v1/chat/completions") {
    seen.xaiStream.push({ auth: req.headers.authorization, model: json.model, messages: json.messages });
    res.writeHead(200, { "content-type": "text/event-stream" });
    let closed = false;
    res.on("close", () => { if (!res.writableFinished) { closed = true; seen.aborted++; } });
    for (const w of "Thanks. Walk me through the last technical problem you fixed.".split(" ")) {
      if (closed) return;
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: w + " " }, finish_reason: null }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 20));
    }
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    return res.end("data: [DONE]\n\n");
  }
  res.writeHead(404); res.end();
});
server.listen(port, "127.0.0.1", () => console.log(`MOCK providers on ${port}`));
