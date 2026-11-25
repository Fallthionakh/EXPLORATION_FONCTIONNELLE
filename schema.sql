-- Schéma de la base D1 « exploration-fonctionnelle »
CREATE TABLE IF NOT EXISTS items (
  col TEXT NOT NULL,          -- 'examens' ou 'rendezvous'
  id TEXT NOT NULL,
  data TEXT NOT NULL,         -- fiche au format JSON
  updated TEXT NOT NULL,
  PRIMARY KEY (col, id)
);
CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  size INTEGER,
  data BLOB NOT NULL,         -- photo ou PDF du compte rendu (max ~1,9 Mo)
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  login TEXT PRIMARY KEY,     -- identifiant (ex. admin, service)
  role TEXT NOT NULL,         -- 'admin' ou 'service'
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,         -- mot de passe haché PBKDF2-SHA256
  ver INTEGER NOT NULL DEFAULT 1,
  updated TEXT NOT NULL
);
