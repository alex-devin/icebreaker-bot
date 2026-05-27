import Database from 'better-sqlite3';

export type ContentType = 'icebreaker' | 'funfact' | 'joke';
export type Source = 'manual' | 'scheduled' | 'mention';

export interface PromptResult {
  id: number;
  text: string;
  contentType: ContentType;
}

export interface PromptService {
  reservePrompt(
    teamId: string,
    channelId: string,
    contentType: ContentType,
    source: Source,
    askedBy?: string,
  ): PromptResult | null;

  releaseReservation(
    teamId: string,
    channelId: string,
    contentType: ContentType,
    promptId: number,
  ): void;

  updateMessageTs(
    teamId: string,
    channelId: string,
    contentType: ContentType,
    promptId: number,
    messageTs: string,
  ): void;

  resetMemory(teamId: string, channelId: string, contentType: ContentType): void;

  getRemainingCount(teamId: string, channelId: string, contentType: ContentType): number;

  getTotalCount(contentType: ContentType): number;
}

export function createPromptService(db: Database.Database): PromptService {
  function getMemoryGeneration(teamId: string, channelId: string, contentType: ContentType): number {
    const row = db.prepare(
      'SELECT memory_generation FROM channel_memory WHERE team_id = ? AND channel_id = ? AND content_type = ?',
    ).get(teamId, channelId, contentType) as { memory_generation: number } | undefined;

    if (!row) {
      db.prepare(
        'INSERT INTO channel_memory (team_id, channel_id, content_type, memory_generation) VALUES (?, ?, ?, 1)',
      ).run(teamId, channelId, contentType);
      return 1;
    }
    return row.memory_generation;
  }

  const reservePromptTxn = db.transaction((
    teamId: string,
    channelId: string,
    contentType: ContentType,
    source: Source,
    askedBy: string | undefined,
  ): PromptResult | null => {
    const generation = getMemoryGeneration(teamId, channelId, contentType);

    const row = db.prepare(`
      SELECT p.id, p.text, p.content_type
      FROM prompts p
      WHERE p.content_type = ? AND p.active = 1
        AND p.id NOT IN (
          SELECT ph.prompt_id FROM prompt_history ph
          WHERE ph.team_id = ? AND ph.channel_id = ? AND ph.content_type = ? AND ph.memory_generation = ?
        )
      ORDER BY RANDOM()
      LIMIT 1
    `).get(contentType, teamId, channelId, contentType, generation) as
      { id: number; text: string; content_type: string } | undefined;

    if (!row) return null;

    db.prepare(`
      INSERT OR IGNORE INTO prompt_history (team_id, channel_id, content_type, memory_generation, prompt_id, source, asked_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(teamId, channelId, contentType, generation, row.id, source, askedBy || null);

    return {
      id: row.id,
      text: row.text,
      contentType: row.content_type as ContentType,
    };
  });

  function reservePrompt(
    teamId: string,
    channelId: string,
    contentType: ContentType,
    source: Source,
    askedBy?: string,
  ): PromptResult | null {
    return reservePromptTxn(teamId, channelId, contentType, source, askedBy);
  }

  function releaseReservation(
    teamId: string,
    channelId: string,
    contentType: ContentType,
    promptId: number,
  ): void {
    const generation = getMemoryGeneration(teamId, channelId, contentType);
    db.prepare(`
      DELETE FROM prompt_history
      WHERE team_id = ? AND channel_id = ? AND content_type = ? AND memory_generation = ? AND prompt_id = ?
    `).run(teamId, channelId, contentType, generation, promptId);
  }

  function updateMessageTs(
    teamId: string,
    channelId: string,
    contentType: ContentType,
    promptId: number,
    messageTs: string,
  ): void {
    const generation = getMemoryGeneration(teamId, channelId, contentType);
    db.prepare(`
      UPDATE prompt_history SET message_ts = ?
      WHERE team_id = ? AND channel_id = ? AND content_type = ? AND memory_generation = ? AND prompt_id = ?
    `).run(messageTs, teamId, channelId, contentType, generation, promptId);
  }

  function resetMemory(teamId: string, channelId: string, contentType: ContentType): void {
    db.prepare(`
      INSERT INTO channel_memory (team_id, channel_id, content_type, memory_generation, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'))
      ON CONFLICT(team_id, channel_id, content_type)
      DO UPDATE SET memory_generation = memory_generation + 1, updated_at = datetime('now')
    `).run(teamId, channelId, contentType);
  }

  function getRemainingCount(teamId: string, channelId: string, contentType: ContentType): number {
    const generation = getMemoryGeneration(teamId, channelId, contentType);
    const total = getTotalCount(contentType);

    const used = db.prepare(`
      SELECT COUNT(*) as count FROM prompt_history
      WHERE team_id = ? AND channel_id = ? AND content_type = ? AND memory_generation = ?
    `).get(teamId, channelId, contentType, generation) as { count: number };

    return Math.max(0, total - used.count);
  }

  function getTotalCount(contentType: ContentType): number {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM prompts WHERE content_type = ? AND active = 1',
    ).get(contentType) as { count: number };
    return row.count;
  }

  return {
    reservePrompt,
    releaseReservation,
    updateMessageTs,
    resetMemory,
    getRemainingCount,
    getTotalCount,
  };
}
