-- Rotina diária no celular: tarefas manuais (WhatsApp, Instagram, ligação), canal das mensagens,
-- mini-auditoria pública por lead, canais sociais da empresa e supressão por telefone/Instagram.

CREATE TABLE tasks (
  id              INTEGER PRIMARY KEY,
  lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  appointment_id  INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('reply','hot','touch','meeting','decide')),
  channel         TEXT NOT NULL DEFAULT 'none' CHECK (channel IN ('whatsapp','instagram','phone','email','none')),
  step            INTEGER NOT NULL DEFAULT 0,
  priority        INTEGER NOT NULL DEFAULT 50,
  title           TEXT NOT NULL,
  reason          TEXT,
  message         TEXT,
  due_date        TEXT NOT NULL,              -- AAAA-MM-DD no fuso configurado
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','skipped','expired')),
  dedupe_key      TEXT UNIQUE,
  done_at         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_tasks_open ON tasks(status, due_date, priority);
CREATE INDEX idx_tasks_lead ON tasks(lead_id);

ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'email';

ALTER TABLE leads ADD COLUMN audit_token TEXT;
ALTER TABLE leads ADD COLUMN audit_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN audit_first_viewed_at TEXT;
ALTER TABLE leads ADD COLUMN audit_last_viewed_at TEXT;
ALTER TABLE leads ADD COLUMN manual_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN last_manual_at TEXT;
CREATE UNIQUE INDEX idx_leads_audit_token ON leads(audit_token);

ALTER TABLE companies ADD COLUMN instagram TEXT;
ALTER TABLE companies ADD COLUMN whatsapp TEXT;
ALTER TABLE contacts ADD COLUMN person_name TEXT;
ALTER TABLE appointments ADD COLUMN meet_link TEXT;

-- SQLite não altera CHECK: recria a lista de supressão aceitando telefone e Instagram
CREATE TABLE suppression_list_new (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('email','domain','phone','instagram')),
  value      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  source     TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (type, value)
);
INSERT INTO suppression_list_new (id, type, value, reason, source, created_at)
  SELECT id, type, value, reason, source, created_at FROM suppression_list;
DROP TABLE suppression_list;
ALTER TABLE suppression_list_new RENAME TO suppression_list;
