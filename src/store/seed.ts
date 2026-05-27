import { getDb } from './db';
import prompts from '../../prompts.json';
import Database from 'better-sqlite3';

type ContentType = 'icebreaker' | 'funfact' | 'joke';

interface PromptItem {
  id: string;
  text: string;
  source_name?: string;
  source_url?: string;
  license?: string;
  reviewed_at?: string;
}

export function seedPrompts(dbOrPath?: Database.Database | string): void {
  const db = typeof dbOrPath === 'string' || dbOrPath === undefined
    ? getDb(dbOrPath)
    : dbOrPath;

  const upsert = db.prepare(`
    INSERT INTO prompts (content_id, content_type, text, source_name, source_url, license, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_id) DO UPDATE SET
      text = excluded.text,
      source_name = excluded.source_name,
      source_url = excluded.source_url,
      license = excluded.license,
      reviewed_at = excluded.reviewed_at
  `);

  const upsertAll = db.transaction(() => {
    for (const [contentType, items] of Object.entries(prompts)) {
      for (const item of items as PromptItem[]) {
        upsert.run(
          item.id,
          contentType as ContentType,
          item.text,
          item.source_name || null,
          item.source_url || null,
          item.license || null,
          item.reviewed_at || null,
        );
      }
    }
  });

  upsertAll();
  console.log('Prompts synced successfully.');
}

if (require.main === module) {
  seedPrompts();
}
