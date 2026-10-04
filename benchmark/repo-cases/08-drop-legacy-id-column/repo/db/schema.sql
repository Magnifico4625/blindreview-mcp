CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  partner TEXT,
  legacy_id TEXT,
  created_at TEXT NOT NULL
);
