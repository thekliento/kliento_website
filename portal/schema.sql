-- Kliento Portal. Every row carries client so a second client reuses the same tables.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  modules TEXT NOT NULL DEFAULT '["tasks"]',
  pw_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  email_verified_at INTEGER,
  failed_pw INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rp_id TEXT NOT NULL DEFAULT 'thekliento.com',
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);

-- stage: enroll = may only add a passkey; full = signed in
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('enroll','full')),
  remember INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- short-lived login steps: verify, passkey_auth, passkey_reg, setup
CREATE TABLE IF NOT EXISTS pending (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  secret_hash TEXT,
  challenge TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  ip TEXT,
  method TEXT,
  path TEXT,
  action TEXT,
  status INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);

-- CORE RULE (Camilo, 2026-09-24): an account can only exist for an email on this list.
-- The website cannot add to it; only a direct database change can. Triggers enforce it
-- even if the Worker code were wrong. Since 2026-09-25 people on the list make their own
-- account at /join (client comes from here); everyone else is refused at the first step.
CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT 'riverworks'
);
INSERT OR IGNORE INTO allowed_emails (email, name) VALUES
  ('crivas@thekliento.com', 'Camilo Rivas'),
  ('sports@buffaloriverworks.com', 'RiverWorks shared'),
  ('sgreen@buffaloriverworks.com', 'Sean Green'),
  ('bcasale@pearlstreetgrill.com', 'Bill Casale'),
  ('mchase@buffaloriverworks.com', 'Matt Chase'),
  ('vtag@buffaloriverworks.com', 'Marc Vitagliano'),
  ('ccasale@buffaloriverworks.com', 'Collin Casale'),
  ('jernst@buffaloriverworks.com', 'Jess Ernst');
UPDATE allowed_emails SET client = 'kliento' WHERE email = 'crivas@thekliento.com';
CREATE TRIGGER IF NOT EXISTS users_email_allowed_insert BEFORE INSERT ON users
  WHEN NOT EXISTS (SELECT 1 FROM allowed_emails WHERE email = NEW.email)
  BEGIN SELECT RAISE(ABORT, 'email not on the allowed list'); END;
CREATE TRIGGER IF NOT EXISTS users_email_allowed_update BEFORE UPDATE OF email ON users
  WHEN NOT EXISTS (SELECT 1 FROM allowed_emails WHERE email = NEW.email)
  BEGIN SELECT RAISE(ABORT, 'email not on the allowed list'); END;

-- rw task-6b: Web & IT tasks, their history, and private files (bytes live in KV FILES).
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('new','todo','doing','waiting','done')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  cc TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','request')),
  mail_status TEXT NOT NULL DEFAULT 'none' CHECK (mail_status IN ('none','sending','sent','failed')),
  mail_error TEXT,
  mail_tries INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_client ON tasks(client, status);
INSERT INTO sqlite_sequence (name, seq) SELECT 'tasks', 1000 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'tasks');

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  from_val TEXT,
  to_val TEXT
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);

-- task_id stays NULL between the upload and the send; the daily cron clears old strays.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  uploaded_by TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_task ON files(task_id);
CREATE INDEX IF NOT EXISTS files_stray ON files(uploaded_by, created_at);
