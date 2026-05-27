import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDb } from '../src/store/db';
import { seedPrompts } from '../src/store/seed';

let db: Database.Database;

afterEach(() => {
  if (db) db.close();
});

describe('seedPrompts', () => {
  it('inserts prompts on first run', () => {
    db = createDb(':memory:');
    seedPrompts(db);

    const count = db.prepare('SELECT COUNT(*) as c FROM prompts').get() as { c: number };
    expect(count.c).toBe(80); // 30 + 25 + 25
  });

  it('is idempotent — running twice does not duplicate', () => {
    db = createDb(':memory:');
    seedPrompts(db);
    seedPrompts(db);

    const count = db.prepare('SELECT COUNT(*) as c FROM prompts').get() as { c: number };
    expect(count.c).toBe(80);
  });

  it('updates text when prompt content changes', () => {
    db = createDb(':memory:');
    seedPrompts(db);

    // Manually change text for a known content_id
    db.prepare("UPDATE prompts SET text = 'old text' WHERE content_id = 'icebreaker-001'").run();

    seedPrompts(db);

    const row = db.prepare("SELECT text FROM prompts WHERE content_id = 'icebreaker-001'").get() as { text: string };
    expect(row.text).not.toBe('old text');
  });

  it('preserves existing row ids across reseeds', () => {
    db = createDb(':memory:');
    seedPrompts(db);

    const idBefore = db.prepare("SELECT id FROM prompts WHERE content_id = 'joke-005'").get() as { id: number };

    seedPrompts(db);

    const idAfter = db.prepare("SELECT id FROM prompts WHERE content_id = 'joke-005'").get() as { id: number };
    expect(idAfter.id).toBe(idBefore.id);
  });
});
