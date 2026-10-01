import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS character_state (
  character_id TEXT PRIMARY KEY,
  activity TEXT NOT NULL,
  activity_since INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  topic TEXT,
  topic_started_at INTEGER,
  last_user_at INTEGER NOT NULL DEFAULT 0,
  last_bot_at INTEGER NOT NULL DEFAULT 0,
  attention REAL,
  attention_raised_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'bot')),
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  generation_id TEXT,
  conversation_version INTEGER,
  ord INTEGER,
  status TEXT,
  due_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_conv_at ON messages (conversation_id, at);
CREATE TABLE IF NOT EXISTS turn_buffers (
  conversation_id TEXT PRIMARY KEY,
  message_ids TEXT NOT NULL,
  texts TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  due_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
`;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
