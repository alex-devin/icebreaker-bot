import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { WebClient } from '@slack/web-api';
import { createDb } from '../src/store/db';
import { createPromptService, PromptService } from '../src/prompts/promptService';
import { createScheduleService, ScheduleService } from '../src/schedule/scheduleService';
import { createScheduler, Scheduler } from '../src/scheduler/scheduler';

const PAST_TS = '2020-01-01T00:00:00.000Z';

let db: Database.Database;
let promptService: PromptService;
let scheduleService: ScheduleService;
let mockPostMessage: ReturnType<typeof vi.fn>;
let mockClient: WebClient;
let scheduler: Scheduler;
let nextContentId = 1;

function seedPrompt(database: Database.Database, type: string): number {
  const result = database.prepare(
    'INSERT INTO prompts (content_id, content_type, text) VALUES (?, ?, ?)',
  ).run(`sched-test-${type}-${nextContentId++}`, type, `${type} test prompt`);
  return result.lastInsertRowid as number;
}

function makeConfigDue(configId: number): void {
  db.prepare("UPDATE channel_configs SET next_run_at = ? WHERE id = ?").run(PAST_TS, configId);
}

function getNextRunAt(configId: number): string {
  const row = db.prepare('SELECT next_run_at FROM channel_configs WHERE id = ?').get(configId) as { next_run_at: string };
  return row.next_run_at;
}

function historyCount(teamId: string, channelId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as c FROM prompt_history WHERE team_id = ? AND channel_id = ?',
  ).get(teamId, channelId) as { c: number };
  return row.c;
}

function makeSlackError(code: string): Error {
  const err: any = new Error(`slack error: ${code}`);
  err.data = { error: code };
  return err;
}

beforeEach(() => {
  db = createDb(':memory:');
  promptService = createPromptService(db);
  scheduleService = createScheduleService(db);
  mockPostMessage = vi.fn();
  mockClient = { chat: { postMessage: mockPostMessage } } as unknown as WebClient;
  scheduler = createScheduler(mockClient, promptService, scheduleService, 999);
  nextContentId = 1;
});

afterEach(() => {
  db.close();
});

describe('scheduler tick', () => {
  it('successful post consumes the prompt and advances next_run_at', async () => {
    seedPrompt(db, 'icebreaker');
    const config = scheduleService.upsertConfig({
      teamId: 'T1', channelId: 'C1', frequency: 'daily', weekday: null,
      timeOfDay: '09:00', timezone: 'UTC', anchorDate: null,
      scheduledContentType: 'icebreaker', userId: 'U1',
    });
    makeConfigDue(config.id);
    mockPostMessage.mockResolvedValueOnce({ ts: '1234567890.000001', ok: true });

    await scheduler.tick();

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(historyCount('T1', 'C1')).toBe(1);
    expect(getNextRunAt(config.id)).not.toBe(PAST_TS);
  });

  it('rate-limited post releases the prompt and does not advance next_run_at', async () => {
    seedPrompt(db, 'icebreaker');
    const config = scheduleService.upsertConfig({
      teamId: 'T1', channelId: 'C1', frequency: 'daily', weekday: null,
      timeOfDay: '09:00', timezone: 'UTC', anchorDate: null,
      scheduledContentType: 'icebreaker', userId: 'U1',
    });
    makeConfigDue(config.id);
    mockPostMessage.mockRejectedValueOnce(makeSlackError('ratelimited'));

    await scheduler.tick();

    expect(historyCount('T1', 'C1')).toBe(0);
    expect(getNextRunAt(config.id)).toBe(PAST_TS);
  });

  it('not_in_channel post releases the prompt and does not advance next_run_at', async () => {
    seedPrompt(db, 'icebreaker');
    const config = scheduleService.upsertConfig({
      teamId: 'T1', channelId: 'C1', frequency: 'daily', weekday: null,
      timeOfDay: '09:00', timezone: 'UTC', anchorDate: null,
      scheduledContentType: 'icebreaker', userId: 'U1',
    });
    makeConfigDue(config.id);
    mockPostMessage.mockRejectedValueOnce(makeSlackError('not_in_channel'));

    await scheduler.tick();

    expect(historyCount('T1', 'C1')).toBe(0);
    expect(getNextRunAt(config.id)).toBe(PAST_TS);
  });

  it('no_permission post releases the prompt and does not advance next_run_at', async () => {
    seedPrompt(db, 'icebreaker');
    const config = scheduleService.upsertConfig({
      teamId: 'T1', channelId: 'C1', frequency: 'daily', weekday: null,
      timeOfDay: '09:00', timezone: 'UTC', anchorDate: null,
      scheduledContentType: 'icebreaker', userId: 'U1',
    });
    makeConfigDue(config.id);
    mockPostMessage.mockRejectedValueOnce(makeSlackError('no_permission'));

    await scheduler.tick();

    expect(historyCount('T1', 'C1')).toBe(0);
    expect(getNextRunAt(config.id)).toBe(PAST_TS);
  });

  it('unknown error releases the prompt and advances next_run_at', async () => {
    seedPrompt(db, 'icebreaker');
    const config = scheduleService.upsertConfig({
      teamId: 'T1', channelId: 'C1', frequency: 'daily', weekday: null,
      timeOfDay: '09:00', timezone: 'UTC', anchorDate: null,
      scheduledContentType: 'icebreaker', userId: 'U1',
    });
    makeConfigDue(config.id);
    mockPostMessage.mockRejectedValueOnce(new Error('unexpected network failure'));

    await scheduler.tick();

    expect(historyCount('T1', 'C1')).toBe(0);
    expect(getNextRunAt(config.id)).not.toBe(PAST_TS);
  });

  it('after rate-limit release, prompt is available on next tick', async () => {
    seedPrompt(db, 'icebreaker');
    const config = scheduleService.upsertConfig({
      teamId: 'T1', channelId: 'C1', frequency: 'daily', weekday: null,
      timeOfDay: '09:00', timezone: 'UTC', anchorDate: null,
      scheduledContentType: 'icebreaker', userId: 'U1',
    });
    makeConfigDue(config.id);

    // First tick: rate limited
    mockPostMessage.mockRejectedValueOnce(makeSlackError('ratelimited'));
    await scheduler.tick();
    expect(historyCount('T1', 'C1')).toBe(0);

    // Config is still due (next_run_at not advanced)
    // Second tick: succeeds
    mockPostMessage.mockResolvedValueOnce({ ts: '9999.0001', ok: true });
    await scheduler.tick();
    expect(historyCount('T1', 'C1')).toBe(1);
  });
});

describe('biweekly example anchor date', () => {
  it('2026-05-28 (used in help text and README) is a Thursday', () => {
    // Verifies the anchor date in /icebreaker help and README is valid.
    // computeNextRun would throw at runtime if weekday and anchor disagree.
    const { DateTime } = require('luxon');
    const dt = DateTime.fromISO('2026-05-28', { zone: 'UTC' });
    expect(dt.weekday).toBe(4); // Luxon: Thursday = 4
  });
});
