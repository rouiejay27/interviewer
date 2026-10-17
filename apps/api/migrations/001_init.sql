-- Phase 1 PoC schema. One row per live interview session.
CREATE TABLE sessions (
  id                     UUID PRIMARY KEY,
  tavus_conversation_id  TEXT UNIQUE,
  status                 TEXT NOT NULL DEFAULT 'creating', -- creating | active | ended | failed
  end_reason             TEXT,
  max_call_seconds       INTEGER NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at               TIMESTAMPTZ
);

-- Every provider webhook, stored once (dedupe_key makes retries harmless).
CREATE TABLE webhook_events (
  id           BIGSERIAL PRIMARY KEY,
  dedupe_key   TEXT NOT NULL UNIQUE,
  conversation_id TEXT,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transcript of record from application.transcription_ready.
CREATE TABLE transcripts (
  session_id   UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  entries      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backup log of turns seen by the custom LLM endpoint (deduplicated).
CREATE TABLE turn_log (
  id           BIGSERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  next_action  TEXT,
  first_token_ms INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, role, content_hash)
);

CREATE INDEX sessions_status_idx ON sessions (status, created_at);
