import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPromptService, ContentType, PromptService } from '../src/prompts/promptService';
import { createDb } from '../src/store/db';

let db: Database.Database;
let service: PromptService;

let nextContentId = 1;

function seedTestPrompts(database: Database.Database, type: ContentType, count: number): void {
  const insert = database.prepare('INSERT INTO prompts (content_id, content_type, text) VALUES (?, ?, ?)');
  for (let i = 1; i <= count; i++) {
    insert.run(`test-${type}-${nextContentId++}`, type, `${type} prompt ${i}`);
  }
}

beforeEach(() => {
  db = createDb(':memory:');
  service = createPromptService(db);
  nextContentId = 1;
});

afterEach(() => {
  db.close();
});

describe('promptService', () => {
  describe('reservePrompt', () => {
    it('returns a prompt from the database', () => {
      seedTestPrompts(db, 'icebreaker', 5);
      const result = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual', 'U1');
      expect(result).not.toBeNull();
      expect(result!.contentType).toBe('icebreaker');
      expect(result!.text).toMatch(/^icebreaker prompt \d$/);
    });

    it('does not repeat prompts before exhaustion', () => {
      seedTestPrompts(db, 'icebreaker', 3);
      const seen = new Set<number>();

      for (let i = 0; i < 3; i++) {
        const result = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual', 'U1');
        expect(result).not.toBeNull();
        expect(seen.has(result!.id)).toBe(false);
        seen.add(result!.id);
      }

      expect(seen.size).toBe(3);
    });

    it('returns null when all prompts are exhausted', () => {
      seedTestPrompts(db, 'joke', 2);

      service.reservePrompt('T1', 'C1', 'joke', 'manual', 'U1');
      service.reservePrompt('T1', 'C1', 'joke', 'manual', 'U1');

      const result = service.reservePrompt('T1', 'C1', 'joke', 'manual', 'U1');
      expect(result).toBeNull();
    });

    it('separates history by channel', () => {
      seedTestPrompts(db, 'icebreaker', 2);

      service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');

      // C1 is exhausted
      expect(service.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).toBeNull();

      // C2 still has all prompts available
      const r3 = service.reservePrompt('T1', 'C2', 'icebreaker', 'manual');
      expect(r3).not.toBeNull();
    });

    it('separates history by content type', () => {
      seedTestPrompts(db, 'icebreaker', 2);
      seedTestPrompts(db, 'joke', 2);

      // Exhaust icebreakers for C1
      service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');

      expect(service.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).toBeNull();

      // Jokes are still available in C1
      const joke = service.reservePrompt('T1', 'C1', 'joke', 'manual');
      expect(joke).not.toBeNull();
    });

    it('manual and scheduled posts share history', () => {
      seedTestPrompts(db, 'funfact', 2);

      const r1 = service.reservePrompt('T1', 'C1', 'funfact', 'manual');
      const r2 = service.reservePrompt('T1', 'C1', 'funfact', 'scheduled');

      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r1!.id).not.toBe(r2!.id);

      // Both sources share the same pool — now exhausted
      expect(service.reservePrompt('T1', 'C1', 'funfact', 'manual')).toBeNull();
      expect(service.reservePrompt('T1', 'C1', 'funfact', 'scheduled')).toBeNull();
    });

    it('atomically reserves so concurrent calls cannot get the same prompt', () => {
      seedTestPrompts(db, 'icebreaker', 1);

      const r1 = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      const r2 = service.reservePrompt('T1', 'C1', 'icebreaker', 'scheduled');

      // Only one should succeed since there's only one prompt
      expect(r1).not.toBeNull();
      expect(r2).toBeNull();
    });
  });

  describe('updateMessageTs', () => {
    it('stores message_ts after successful post', () => {
      seedTestPrompts(db, 'icebreaker', 3);
      const result = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual', 'U1');
      service.updateMessageTs('T1', 'C1', 'icebreaker', result!.id, '1234567890.123456');

      const row = db.prepare(
        'SELECT message_ts FROM prompt_history WHERE prompt_id = ?',
      ).get(result!.id) as { message_ts: string };
      expect(row.message_ts).toBe('1234567890.123456');
    });
  });

  describe('releaseReservation', () => {
    it('makes a reserved prompt available again', () => {
      seedTestPrompts(db, 'icebreaker', 1);

      const r1 = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      expect(r1).not.toBeNull();

      // Exhausted after one reservation
      expect(service.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).toBeNull();

      // Release — prompt is available again
      service.releaseReservation('T1', 'C1', 'icebreaker', r1!.id);
      const r2 = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      expect(r2).not.toBeNull();
      expect(r2!.id).toBe(r1!.id);
    });

    it('does not affect other prompts in the pool', () => {
      seedTestPrompts(db, 'icebreaker', 3);

      const r1 = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      const r2 = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');

      // Exhausted
      expect(service.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).toBeNull();
      expect(service.getRemainingCount('T1', 'C1', 'icebreaker')).toBe(0);

      // Release one
      service.releaseReservation('T1', 'C1', 'icebreaker', r1!.id);
      expect(service.getRemainingCount('T1', 'C1', 'icebreaker')).toBe(1);

      // The released prompt is available; the other two are still used
      const r4 = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      expect(r4).not.toBeNull();
      expect(r4!.id).toBe(r1!.id);
      expect(r4!.id).not.toBe(r2!.id);
    });

    it('does not affect other channels', () => {
      seedTestPrompts(db, 'icebreaker', 1);

      const r1 = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      service.reservePrompt('T1', 'C2', 'icebreaker', 'manual');

      service.releaseReservation('T1', 'C1', 'icebreaker', r1!.id);

      // C2 is still exhausted
      expect(service.reservePrompt('T1', 'C2', 'icebreaker', 'manual')).toBeNull();

      // C1 is available again
      expect(service.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).not.toBeNull();
    });

    it('does not affect other content types', () => {
      seedTestPrompts(db, 'icebreaker', 1);
      seedTestPrompts(db, 'joke', 1);

      const ice = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      service.reservePrompt('T1', 'C1', 'joke', 'manual');

      service.releaseReservation('T1', 'C1', 'icebreaker', ice!.id);

      // Joke is still used
      expect(service.reservePrompt('T1', 'C1', 'joke', 'manual')).toBeNull();

      // Icebreaker is available again
      expect(service.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).not.toBeNull();
    });
  });

  describe('resetMemory', () => {
    it('allows prompts to be used again after reset', () => {
      seedTestPrompts(db, 'icebreaker', 2);

      service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');

      expect(service.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).toBeNull();

      service.resetMemory('T1', 'C1', 'icebreaker');

      const after = service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      expect(after).not.toBeNull();
    });

    it('only resets the specified content type', () => {
      seedTestPrompts(db, 'icebreaker', 1);
      seedTestPrompts(db, 'joke', 1);

      service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');
      service.reservePrompt('T1', 'C1', 'joke', 'manual');

      service.resetMemory('T1', 'C1', 'icebreaker');

      expect(service.reservePrompt('T1', 'C1', 'icebreaker', 'manual')).not.toBeNull();
      expect(service.reservePrompt('T1', 'C1', 'joke', 'manual')).toBeNull();
    });
  });

  describe('getRemainingCount', () => {
    it('returns correct remaining count', () => {
      seedTestPrompts(db, 'icebreaker', 5);

      expect(service.getRemainingCount('T1', 'C1', 'icebreaker')).toBe(5);

      service.reservePrompt('T1', 'C1', 'icebreaker', 'manual');

      expect(service.getRemainingCount('T1', 'C1', 'icebreaker')).toBe(4);
    });

    it('resets count after memory reset', () => {
      seedTestPrompts(db, 'joke', 3);

      service.reservePrompt('T1', 'C1', 'joke', 'manual');
      service.reservePrompt('T1', 'C1', 'joke', 'manual');
      service.reservePrompt('T1', 'C1', 'joke', 'manual');

      expect(service.getRemainingCount('T1', 'C1', 'joke')).toBe(0);

      service.resetMemory('T1', 'C1', 'joke');
      expect(service.getRemainingCount('T1', 'C1', 'joke')).toBe(3);
    });
  });
});
