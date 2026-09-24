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

-- short-lived login steps: email_code, passkey_auth, passkey_reg, setup
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
-- even if the Worker code were wrong.
CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT NOT NULL
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
CREATE TRIGGER IF NOT EXISTS users_email_allowed_insert BEFORE INSERT ON users
  WHEN NOT EXISTS (SELECT 1 FROM allowed_emails WHERE email = NEW.email)
  BEGIN SELECT RAISE(ABORT, 'email not on the allowed list'); END;
CREATE TRIGGER IF NOT EXISTS users_email_allowed_update BEFORE UPDATE OF email ON users
  WHEN NOT EXISTS (SELECT 1 FROM allowed_emails WHERE email = NEW.email)
  BEGIN SELECT RAISE(ABORT, 'email not on the allowed list'); END;
