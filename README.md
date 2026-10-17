# iNTERVIEWER

A real-time AI video interviewer. An applicant joins a browser link and speaks with a realistic talking avatar; the system keeps the transcript and (in later phases) produces an evidence-linked report for a human recruiter, who makes every hiring decision.

> **Status: Phase 1, live-call proof of concept.** Not production software. The avatar call, interview logic, transcript capture, and cleanup are implemented; they have been tested against mock providers only until the live checks below are run.

## How it works (Phase 1)

```
Browser test page ──join──► Tavus CVI room (WebRTC: speech-to-text, turn-taking, voice, avatar)
                                   │  each applicant turn
                                   ▼
                     This API: /llm/v1/chat/completions  ("Interview brain")
                       derives interview state from the full history
                       builds the interviewer prompt
                       streams the reply from xAI Grok back to Tavus
Tavus webhooks ───────────────►  /webhooks/tavus  (shutdown reason, transcript of record)
```

- **Tavus** owns media, speech, and the avatar. Its perception (face and emotion analysis) is turned **off**.
- **This API** owns the interview: question order, follow-ups, repeats, time limit, transcript storage, and session cleanup.
- **xAI Grok** only phrases the next line. It never scores anyone.

## Requirements

- Windows 10/11 (or macOS/Linux), Node.js 22+
- A PostgreSQL database: a free [Neon](https://neon.com) project (recommended, nothing to install) or local Docker
- A Tavus developer account (free plan works: 5-minute calls, 20 minutes/month)
- An xAI API key with a monthly spending limit set
- A public HTTPS tunnel to your computer, so Tavus can reach this API

## Setup (Windows PowerShell, inside this folder)

1. **Install packages**
   ```powershell
   npm install
   ```
2. **Connect the database.** In the Neon Console press **Connect** and copy two strings into `.env` (step 3):
   - `DATABASE_URL`: the **pooled** string (host contains `-pooler`), used by the app
   - `DATABASE_URL_UNPOOLED`: the same string **without** `-pooler`, used for migrations

   Local Docker alternative: `npm run db:up` and `DATABASE_URL=postgres://interviewer:interviewer@localhost:5433/interviewer`.
3. **Create your settings file**
   ```powershell
   Copy-Item .env.example .env
   npm run secrets
   ```
   Paste the three printed secrets and the two database strings into `.env`, then fill in `TAVUS_API_KEY`, `XAI_API_KEY`, and `TAVUS_FACE_ID` (a stock face ID from the Tavus dashboard). Never commit `.env` or paste its values anywhere.
   Check the database end to end (connects, applies migrations, writes and deletes a test row):
   ```powershell
   npm run db:check
   ```
4. **Start a tunnel** in a second PowerShell window. One option is Cloudflare's free quick tunnel (no account):
   ```powershell
   winget install Cloudflare.cloudflared
   cloudflared tunnel --url http://localhost:3001
   ```
   Copy the `https://....trycloudflare.com` address into `PUBLIC_BASE_URL` in `.env`. Quick-tunnel addresses change every time, so repeat step 5 whenever it changes.
5. **Create the Tavus PAL** (points Tavus at this API as its custom LLM)
   ```powershell
   npm run create-pal
   ```
   Put the printed `TAVUS_PAL_ID=...` line into `.env`.
6. **Run the API**
   ```powershell
   npm run dev
   ```
7. Open **http://localhost:3001**, paste your `POC_ACCESS_TOKEN`, and press **Start interview**.

Tip: set `TAVUS_TEST_MODE=true` to check the plumbing without the avatar joining (Tavus does not charge for test-mode conversations).

## Phase 1 acceptance checks (run on real calls, record results)

| # | Check | How to see it |
| - | --- | --- |
| 1 | Fresh answer: the avatar's reply refers to something you said in this call | Listen; compare with the turn log |
| 2 | Follow-up: a short answer gets one probe tied to your words, then the next question | Turn log shows `action: probe`, then `ask_core` |
| 3 | Interruption: talking over the avatar stops it, and the cut-off sentence never plays later | Listen; API log shows `LLM stream cancelled` |
| 4 | Transcript: stored transcript matches what was said | "Transcript of record" panel after the call |
| 5 | State: question index moves 1 → 2 → 3 → close | API log `custom LLM turn` lines |
| 6 | Cleanup: ending the call or closing the tab ends the Tavus session | Session status `ended`; no active session in the Tavus dashboard |
| 7 | Perception off | PAL created with `perception_model: off` (printed by `create-pal`) |
| 8 | Secrets stay server-side | No keys in browser dev tools or API logs |

Performance targets are **test goals, not guarantees**: avatar reply starts under 1.5 s (p50) after you stop speaking; our endpoint's first token under 600 ms (shown as `first token` in the turn log).

## Development

```powershell
npm run build       # TypeScript strict type check
npm run db:check    # database connection, migrations, write/read/delete
npm test            # interview-logic unit tests
```

## Project layout

```
apps/api/
  src/server.ts            Fastify server, logging with secrets and query strings removed
  src/routes/llm.ts        OpenAI-compatible custom LLM endpoint for Tavus (streaming, barge-in cancel, fallback line)
  src/routes/sessions.ts   Start, end, and inspect a session
  src/routes/webhooks.ts   Idempotent Tavus webhook handler (shutdown, transcript)
  src/interview/           Script, state machine (derived from history), interviewer prompt
  src/tavus.ts             Tavus API client (PAL, conversation, end)
  src/llm/grok.ts          xAI streaming client
  src/sweeper.ts           Ends stale provider sessions every minute
  migrations/              PostgreSQL schema
  public/index.html        Phase 1 test page
docker-compose.yml         Optional local PostgreSQL (port 5433) instead of Neon
```

## Principles

- The AI interviews; a human recruiter decides.
- No suitability judgments from face, eye contact, appearance, accent, voice tone, or emotion.
- Missing evidence is "Not assessed", never a low score. Technical failures never count against the applicant.
- Applicant speech is treated as untrusted data and cannot change the interview rules.
