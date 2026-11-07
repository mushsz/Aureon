-- Aureon · Autonomous Sales Engine — schema inicial (Cloudflare D1 / SQLite)
-- Datas em ISO-8601 UTC (TEXT). JSON guardado como TEXT.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iter INTEGER NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','viewer')),
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,               -- SHA-256 do token (o token em si só existe no cookie)
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE companies (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  cnpj             TEXT UNIQUE,
  segment          TEXT,
  company_type     TEXT,
  country          TEXT NOT NULL DEFAULT 'BR',
  state            TEXT,
  city             TEXT,
  normalized_city  TEXT NOT NULL DEFAULT '',
  website          TEXT,
  domain           TEXT UNIQUE,
  social_url       TEXT,
  email            TEXT,
  phone            TEXT,
  source           TEXT NOT NULL,                  -- osm | manual | cnpj
  source_ref       TEXT UNIQUE,                    -- ex.: osm:node/123
  source_url       TEXT,
  source_tags      TEXT,                           -- JSON com as tags originais relevantes
  cnae_code        TEXT,
  cnae_description TEXT,
  cnae_secondary   TEXT,                           -- JSON [códigos]
  research_status  TEXT NOT NULL DEFAULT 'pending'
                   CHECK (research_status IN ('pending','investigating','investigated','failed','skipped')),
  -- allow: liberada · review: em dúvida, segura para revisão · block: saúde/concorrente · approved: revisada e liberada por pessoa
  exclusion_status TEXT NOT NULL DEFAULT 'allow' CHECK (exclusion_status IN ('allow','review','block','approved')),
  exclusion_reason TEXT,
  exclusion_checked_at TEXT,
  research_attempts INTEGER NOT NULL DEFAULT 0,
  discovered_at    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (normalized_name, normalized_city)
);
CREATE INDEX idx_companies_status ON companies(research_status);
CREATE INDEX idx_companies_exclusion ON companies(exclusion_status);
CREATE INDEX idx_companies_segment ON companies(segment);
CREATE INDEX idx_companies_city ON companies(normalized_city);

CREATE TABLE contacts (
  id                INTEGER PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('email','form','phone','whatsapp','other')),
  value             TEXT NOT NULL,
  normalized_value  TEXT NOT NULL,
  is_role_address   INTEGER NOT NULL DEFAULT 0,
  is_primary        INTEGER NOT NULL DEFAULT 0,
  legal_basis       TEXT,              -- legitimate_interest_b2b | needs_review | none
  legal_basis_notes TEXT,
  status            TEXT NOT NULL DEFAULT 'pending_review'
                    CHECK (status IN ('valid','pending_review','invalid','suppressed')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (company_id, type, normalized_value)
);
CREATE INDEX idx_contacts_value ON contacts(normalized_value);

CREATE TABLE contact_sources (
  id           INTEGER PRIMARY KEY,
  contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_type  TEXT NOT NULL,          -- website | osm | cnpj | manual
  source_url   TEXT,
  evidence     TEXT,
  collected_at TEXT NOT NULL,
  UNIQUE (contact_id, source_type, source_url)
);

CREATE TABLE campaigns (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE leads (
  id               INTEGER PRIMARY KEY,
  company_id       INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id      INTEGER REFERENCES campaigns(id),
  stage            TEXT NOT NULL DEFAULT 'descoberto'
                   CHECK (stage IN ('descoberto','em_analise','qualificado','aguardando_contato','contatado',
                                    'respondeu','interessado','reuniao_agendada','convertido','perdido','nao_contatar')),
  score            INTEGER,
  priority         TEXT CHECK (priority IN ('alta','media','baixa','nao_automatico')),
  service_fit      TEXT,
  contact_id       INTEGER REFERENCES contacts(id),
  contact_pending  INTEGER NOT NULL DEFAULT 0,
  needs_review     INTEGER NOT NULL DEFAULT 0,
  followup_count   INTEGER NOT NULL DEFAULT 0,
  last_contact_at  TEXT,
  last_inbound_at  TEXT,
  lost_reason      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_score ON leads(score);

CREATE TABLE lead_stage_history (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  reason     TEXT,
  actor      TEXT NOT NULL,      -- agente ou user:<id>
  created_at TEXT NOT NULL
);
CREATE INDEX idx_stage_history_lead ON lead_stage_history(lead_id);

CREATE TABLE lead_analyses (
  id              INTEGER PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url             TEXT,
  final_url       TEXT,
  http_status     INTEGER,
  response_ms     INTEGER,
  page_bytes      INTEGER,
  fetch_error     TEXT,
  robots_allowed  INTEGER,
  signals         TEXT NOT NULL,     -- JSON com tudo o que foi observado
  findings        TEXT NOT NULL,     -- JSON [{kind, code, title, evidence, service}]
  psi             TEXT,              -- JSON do PageSpeed (quando usado)
  analyzed_at     TEXT NOT NULL
);
CREATE INDEX idx_analyses_company ON lead_analyses(company_id, analyzed_at);

CREATE TABLE lead_scores (
  id          INTEGER PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  analysis_id INTEGER REFERENCES lead_analyses(id) ON DELETE SET NULL,
  score       INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  priority    TEXT NOT NULL,
  service_fit TEXT,
  breakdown   TEXT NOT NULL,     -- JSON [{criterion, points, max, reason}]
  explanation TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_scores_company ON lead_scores(company_id, created_at);

CREATE TABLE conversations (
  id               INTEGER PRIMARY KEY,
  lead_id          INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  contact_id       INTEGER REFERENCES contacts(id),
  gmail_thread_id  TEXT UNIQUE,
  subject          TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','needs_review','closed')),
  last_message_at  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_conversations_lead ON conversations(lead_id);

CREATE TABLE messages (
  id                 INTEGER PRIMARY KEY,
  conversation_id    INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  lead_id            INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('out','in')),
  kind               TEXT NOT NULL,   -- initial | followup | auto_reply | manual_reply | confirmation | inbound
  status             TEXT NOT NULL CHECK (status IN ('draft','simulated','sending','sent','failed','received','cancelled')),
  service            TEXT,
  template           TEXT,
  subject            TEXT,
  body_text          TEXT,
  to_addr            TEXT,
  from_addr          TEXT,
  gmail_message_id   TEXT UNIQUE,
  rfc_message_id     TEXT,
  classification     TEXT,
  classification_reason TEXT,
  needs_review       INTEGER NOT NULL DEFAULT 0,
  dedupe_key         TEXT UNIQUE,
  error              TEXT,
  sent_at            TEXT,
  received_at        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_messages_lead ON messages(lead_id);
CREATE INDEX idx_messages_status ON messages(status, direction);
CREATE INDEX idx_messages_sent ON messages(sent_at);

CREATE TABLE appointments (
  id                 INTEGER PRIMARY KEY,
  lead_id            INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id    INTEGER REFERENCES conversations(id),
  token_hash         TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL CHECK (status IN ('offered','booked','cancelled')),
  starts_at          TEXT,
  ends_at            TEXT,
  timezone           TEXT NOT NULL,
  attendee_email     TEXT,
  calendar_event_id  TEXT UNIQUE,
  html_link          TEXT,
  token_expires_at   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_appointments_starts ON appointments(starts_at);

CREATE TABLE schedules (
  task             TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  days             TEXT NOT NULL DEFAULT '1,2,3,4,5',   -- 0=domingo … 6=sábado
  start_time       TEXT NOT NULL,                      -- HH:MM no fuso configurado
  end_time         TEXT,                               -- janela; NULL = só uma vez por dia
  interval_minutes INTEGER NOT NULL DEFAULT 0,          -- 0 = uma vez por dia
  batch_size       INTEGER NOT NULL DEFAULT 1,
  paused_until     TEXT,
  paused_reason    TEXT,
  last_run_at      TEXT,
  last_run_date    TEXT,
  last_status      TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE automation_jobs (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','dead','cancelled')),
  priority     INTEGER NOT NULL DEFAULT 5,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after    TEXT NOT NULL,
  locked_at    TEXT,
  lock_id      TEXT,
  last_error   TEXT,
  result       TEXT,
  dedupe_key   TEXT UNIQUE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX idx_jobs_claim ON automation_jobs(status, run_after, priority);

CREATE TABLE automation_logs (
  id         INTEGER PRIMARY KEY,
  level      TEXT NOT NULL CHECK (level IN ('debug','info','warn','error','alert')),
  agent      TEXT NOT NULL,
  job_id     INTEGER,
  message    TEXT NOT NULL,
  data       TEXT,
  seen       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_logs_created ON automation_logs(created_at);
CREATE INDEX idx_logs_level ON automation_logs(level, seen);

CREATE TABLE suppression_list (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('email','domain')),
  value      TEXT NOT NULL,
  reason     TEXT NOT NULL,      -- unsubscribe | refusal | bounce | manual
  source     TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (type, value)
);

CREATE TABLE exclusion_rules (
  id         INTEGER PRIMARY KEY,
  -- keyword/category/cnae bloqueiam; review_* seguram o lead para revisão manual (em dúvida, não prospectar)
  type       TEXT NOT NULL CHECK (type IN ('keyword','review_keyword','category','review_category','cnae','review_cnae','domain','company')),
  value      TEXT NOT NULL,
  reason     TEXT,
  is_system  INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (type, value)
);

CREATE TABLE integrations (
  provider                TEXT PRIMARY KEY,         -- google
  status                  TEXT NOT NULL DEFAULT 'disconnected',
  account_email           TEXT,
  scopes                  TEXT,
  refresh_token_enc       TEXT,
  access_token_enc        TEXT,
  access_token_expires_at TEXT,
  inbox_cursor            TEXT,                     -- epoch (s) do último e-mail lido
  verified_at             TEXT,
  last_error              TEXT,
  connected_at            TEXT,
  updated_at              TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_metrics (
  day     TEXT NOT NULL,       -- AAAA-MM-DD em UTC (as cotas da Cloudflare zeram 00:00 UTC)
  metric  TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  data       TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
