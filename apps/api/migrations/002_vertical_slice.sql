-- Phase 3 vertical slice: vacancy -> approved rubric -> applicant link -> interview -> report.

CREATE TABLE recruiters (
  id             UUID PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Login sessions. Only a hash of the cookie value is stored.
CREATE TABLE recruiter_sessions (
  token_hash     TEXT PRIMARY KEY,
  recruiter_id   UUID NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vacancies (
  id             UUID PRIMARY KEY,
  owner_id       UUID NOT NULL REFERENCES recruiters(id),
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  objectives     TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at    TIMESTAMPTZ
);

-- Rubrics are versioned. A draft can be edited; an approved version is frozen
-- and every interview pins the exact version it used.
CREATE TABLE rubric_versions (
  id             UUID PRIMARY KEY,
  vacancy_id     UUID NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft', -- draft | approved
  source         TEXT NOT NULL,                 -- ai_draft | manual
  content        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at    TIMESTAMPTZ,
  approved_by    UUID REFERENCES recruiters(id),
  UNIQUE (vacancy_id, version)
);

-- Single-use, expiring applicant links. Only a hash of the link token is stored.
CREATE TABLE invites (
  id                 UUID PRIMARY KEY,
  vacancy_id         UUID NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  rubric_version_id  UUID NOT NULL REFERENCES rubric_versions(id),
  candidate_label    TEXT NOT NULL,
  token_hash         TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | started | completed | interrupted | revoked | human_requested
  expires_at         TIMESTAMPTZ NOT NULL,
  created_by         UUID NOT NULL REFERENCES recruiters(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at         TIMESTAMPTZ
);

ALTER TABLE sessions
  ADD COLUMN invite_id UUID REFERENCES invites(id),
  ADD COLUMN rubric_version_id UUID REFERENCES rubric_versions(id);

-- What the applicant agreed to, with the exact notice version shown.
CREATE TABLE consents (
  id                     UUID PRIMARY KEY,
  invite_id              UUID NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
  session_id             UUID REFERENCES sessions(id) ON DELETE CASCADE,
  notice_version         TEXT NOT NULL,
  ai_interview           BOOLEAN NOT NULL,
  transcript_processing  BOOLEAN NOT NULL,
  video_recording        BOOLEAN NOT NULL DEFAULT false,
  accepted_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI evaluation draft for one interview. Never a decision.
CREATE TABLE evaluations (
  session_id     UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  attempts       INTEGER NOT NULL DEFAULT 0,
  model          TEXT,
  result         JSONB,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Human decisions are append-only so the history stays visible.
CREATE TABLE decisions (
  id             BIGSERIAL PRIMARY KEY,
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  recruiter_id   UUID NOT NULL REFERENCES recruiters(id),
  decision       TEXT NOT NULL, -- advance | hold | decline | undecided
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who did what to which record. No applicant content is written here.
CREATE TABLE access_log (
  id             BIGSERIAL PRIMARY KEY,
  actor_type     TEXT NOT NULL, -- recruiter | applicant | system
  actor_id       TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one live call at a time (free plan budget). Makes the "already in progress" check race-free.
-- Older leftovers are closed first so the index can be created (the sweeper ends them at the provider).
UPDATE sessions SET status = 'ended', end_reason = COALESCE(end_reason, 'migration_cleanup'), ended_at = COALESCE(ended_at, now())
WHERE status IN ('creating', 'active')
  AND id <> (SELECT id FROM sessions WHERE status IN ('creating', 'active') ORDER BY created_at DESC LIMIT 1);
CREATE UNIQUE INDEX sessions_one_live_idx ON sessions ((true)) WHERE status IN ('creating', 'active');

CREATE INDEX vacancies_owner_idx ON vacancies (owner_id, created_at DESC);
CREATE INDEX invites_vacancy_idx ON invites (vacancy_id, created_at DESC);
CREATE INDEX sessions_invite_idx ON sessions (invite_id);
CREATE INDEX evaluations_status_idx ON evaluations (status, updated_at);
CREATE INDEX recruiter_sessions_expiry_idx ON recruiter_sessions (expires_at);
