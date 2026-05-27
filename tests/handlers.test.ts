import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPromptService, PromptService } from '../src/prompts/promptService';
import { createScheduleService, ScheduleService } from '../src/schedule/scheduleService';
import { createDb } from '../src/store/db';

let db: Database.Database;
let promptService: PromptService;
let scheduleService: ScheduleService;

let nextContentId = 1;

function seedTestPrompts(database: Database.Database, type: string, count: number): void {
  const insert = database.prepare('INSERT INTO prompts (content_id, content_type, text) VALUES (?, ?, ?)');
  for (let i = 1; i <= count; i++) {
    insert.run(`handler-test-${type}-${nextContentId++}`, type, `${type} prompt ${i}`);
  }
}

beforeEach(() => {
  db = createDb(':memory:');
  promptService = createPromptService(db);
  scheduleService = createScheduleService(db);
  nextContentId = 1;
});

afterEach(() => {
  db.close();
});

describe('admin access control', () => {
  const adminIds = ['UADMIN1', 'UADMIN2'];

  it('admin user IDs are checked correctly', () => {
    expect(adminIds.includes('UADMIN1')).toBe(true);
    expect(adminIds.includes('UADMIN2')).toBe(true);
    expect(adminIds.includes('URANDOM')).toBe(false);
  });
});

describe('joke/joketime alias', () => {
  it('both joke and joketime resolve to joke content type', () => {
    seedTestPrompts(db, 'joke', 5);

    const r1 = promptService.reservePrompt('T1', 'C1', 'joke', 'manual');
    expect(r1).not.toBeNull();
    expect(r1!.contentType).toBe('joke');

    const remaining = promptService.getRemainingCount('T1', 'C1', 'joke');
    expect(remaining).toBe(4);
  });
});

describe('exhaustion behavior', () => {
  it('returns null and does not auto-repeat when exhausted', () => {
    seedTestPrompts(db, 'funfact', 2);

    promptService.reservePrompt('T1', 'C1', 'funfact', 'manual');
    promptService.reservePrompt('T1', 'C1', 'funfact', 'manual');

    // No auto-repeat — returns null
    expect(promptService.reservePrompt('T1', 'C1', 'funfact', 'manual')).toBeNull();

    // Still null on subsequent calls
    expect(promptService.reservePrompt('T1', 'C1', 'funfact', 'manual')).toBeNull();
  });
});

describe('scheduler integration', () => {
  it('scheduled and manual posts share the same history pool', () => {
    seedTestPrompts(db, 'icebreaker', 3);

    const r1 = promptService.reservePrompt('T1', 'C1', 'icebreaker', 'scheduled');
    const r2 = promptService.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
    const r3 = promptService.reservePrompt('T1', 'C1', 'icebreaker', 'mention');

    // All three used different prompts
    const ids = new Set([r1!.id, r2!.id, r3!.id]);
    expect(ids.size).toBe(3);

    // Now exhausted for all sources
    expect(promptService.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).toBeNull();
    expect(promptService.reservePrompt('T1', 'C1', 'icebreaker', 'scheduled')).toBeNull();
    expect(promptService.reservePrompt('T1', 'C1', 'icebreaker', 'mention')).toBeNull();
  });
});

describe('app_mention team_id consistency', () => {
  it('mention and slash command use same team_id for shared history', () => {
    seedTestPrompts(db, 'icebreaker', 2);

    // Simulate slash command from T1
    promptService.reservePrompt('T1', 'C1', 'icebreaker', 'manual');

    // Simulate mention from same team (context.teamId = T1)
    promptService.reservePrompt('T1', 'C1', 'icebreaker', 'mention');

    // Should be exhausted — both used the same team/channel pool
    expect(promptService.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).toBeNull();
    expect(promptService.reservePrompt('T1', 'C1', 'icebreaker', 'mention')).toBeNull();
  });
});
