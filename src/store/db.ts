import Database from 'better-sqlite3';
import path from 'path';

let db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (db) return db;
  const resolvedPath = dbPath || process.env.DATABASE_PATH || './icebreaker.db';
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

export function createDb(dbPath: string): Database.Database {
  const instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  initSchema(instance);
  return instance;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL CHECK(content_type IN ('icebreaker', 'funfact', 'joke')),
      text TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      source_name TEXT,
      source_url TEXT,
      license TEXT,
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS channel_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      frequency TEXT NOT NULL CHECK(frequency IN ('daily', 'weekly', 'biweekly')),
      weekday INTEGER,
      time_of_day TEXT NOT NULL,
      timezone TEXT NOT NULL,
      anchor_date TEXT,
      scheduled_content_type TEXT NOT NULL DEFAULT 'icebreaker'
        CHECK(scheduled_content_type IN ('icebreaker', 'funfact', 'joke', 'random')),
      next_run_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(team_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS channel_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK(content_type IN ('icebreaker', 'funfact', 'joke')),
      memory_generation INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(team_id, channel_id, content_type)
    );

    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK(content_type IN ('icebreaker', 'funfact', 'joke')),
      memory_generation INTEGER NOT NULL,
      prompt_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('manual', 'scheduled', 'mention')),
      asked_by TEXT,
      asked_at TEXT NOT NULL DEFAULT (datetime('now')),
      message_ts TEXT,
      UNIQUE(team_id, channel_id, content_type, memory_generation, prompt_id),
      FOREIGN KEY (prompt_id) REFERENCES prompts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_history_lookup
      ON prompt_history(team_id, channel_id, content_type, memory_generation);

    CREATE INDEX IF NOT EXISTS idx_channel_configs_next_run
      ON channel_configs(next_run_at, active);
  `);
}
