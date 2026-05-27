import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { createScheduleService, computeNextRun, parseWeekday, isValidTimeOfDay, ScheduleService } from '../src/schedule/scheduleService';
import { createDb } from '../src/store/db';

let db: Database.Database;
let service: ScheduleService;

beforeEach(() => {
  db = createDb(':memory:');
  service = createScheduleService(db);
});

afterEach(() => {
  db.close();
});

describe('parseWeekday', () => {
  it('parses valid weekday names', () => {
    expect(parseWeekday('monday')).toBe(1);
    expect(parseWeekday('Thursday')).toBe(4);
    expect(parseWeekday('SUNDAY')).toBe(7);
  });

  it('returns null for invalid input', () => {
    expect(parseWeekday('notaday')).toBeNull();
    expect(parseWeekday('')).toBeNull();
  });
});

describe('computeNextRun', () => {
  it('computes daily next run in the future', () => {
    const result = computeNextRun('daily', null, '09:00', 'America/New_York', null);
    const parsed = DateTime.fromISO(result, { zone: 'utc' });
    expect(parsed.isValid).toBe(true);
    expect(parsed > DateTime.utc()).toBe(true);
  });

  it('daily rolls to next day if time has passed', () => {
    // Use a time that's certainly in the past today
    const pastTime = '00:01';
    const result = computeNextRun('daily', null, pastTime, 'UTC', null);
    const parsed = DateTime.fromISO(result, { zone: 'utc' });
    const tomorrow = DateTime.utc().plus({ days: 1 }).startOf('day');
    expect(parsed >= tomorrow.set({ hour: 0, minute: 1 })).toBe(true);
  });

  it('computes weekly next run on correct weekday', () => {
    const result = computeNextRun('weekly', 3, '10:00', 'UTC', null);
    const parsed = DateTime.fromISO(result, { zone: 'utc' });
    expect(parsed.weekday).toBe(3); // Wednesday
    expect(parsed > DateTime.utc()).toBe(true);
  });

  it('computes biweekly from anchor date', () => {
    const anchor = '2026-01-05'; // A Monday (weekday 1 in Luxon)
    const result = computeNextRun('biweekly', 1, '09:00', 'UTC', anchor);
    const parsed = DateTime.fromISO(result, { zone: 'utc' });
    expect(parsed > DateTime.utc()).toBe(true);

    // Should be a Monday at 09:00
    expect(parsed.weekday).toBe(1);
    expect(parsed.hour).toBe(9);

    // Distance from anchor should be a multiple of 14 days
    const anchorDt = DateTime.fromISO(anchor, { zone: 'utc' }).set({ hour: 9, minute: 0 });
    const diffDays = parsed.diff(anchorDt, 'days').days;
    expect(diffDays % 14).toBe(0);
  });

  it('advances past afterUtc for weekly', () => {
    const after = '2026-05-28T15:00:00.000Z'; // Wednesday
    const result = computeNextRun('weekly', 4, '10:00', 'UTC', null, after); // Thursday
    const parsed = DateTime.fromISO(result, { zone: 'utc' });
    expect(parsed > DateTime.fromISO(after, { zone: 'utc' })).toBe(true);
    expect(parsed.weekday).toBe(4);
  });

  it('throws when biweekly anchor_date weekday disagrees with weekday param', () => {
    // 2026-05-30 is a Saturday (weekday 6), but we pass thursday (4)
    expect(() => computeNextRun('biweekly', 4, '10:00', 'UTC', '2026-05-30')).toThrow(
      /Saturday.*not.*Thursday/,
    );
  });

  it('accepts biweekly when anchor_date matches weekday', () => {
    // 2026-05-28 is a Thursday (weekday 4)
    const result = computeNextRun('biweekly', 4, '10:00', 'UTC', '2026-05-28');
    const parsed = DateTime.fromISO(result, { zone: 'utc' });
    expect(parsed.weekday).toBe(4);
    expect(parsed.hour).toBe(10);
  });

  it('throws on invalid anchor_date', () => {
    expect(() => computeNextRun('biweekly', 4, '10:00', 'UTC', 'not-a-date')).toThrow(/Invalid anchor date/);
  });
});

describe('scheduleService', () => {
  it('creates and retrieves a config', () => {
    const config = service.upsertConfig({
      teamId: 'T1',
      channelId: 'C1',
      frequency: 'weekly',
      weekday: 4,
      timeOfDay: '10:00',
      timezone: 'America/New_York',
      anchorDate: null,
      scheduledContentType: 'icebreaker',
      userId: 'U1',
    });

    expect(config.teamId).toBe('T1');
    expect(config.frequency).toBe('weekly');
    expect(config.scheduledContentType).toBe('icebreaker');

    const retrieved = service.getConfig('T1', 'C1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(config.id);
  });

  it('upsert updates existing config', () => {
    service.upsertConfig({
      teamId: 'T1',
      channelId: 'C1',
      frequency: 'daily',
      weekday: null,
      timeOfDay: '09:00',
      timezone: 'UTC',
      anchorDate: null,
      scheduledContentType: 'random',
      userId: 'U1',
    });

    service.upsertConfig({
      teamId: 'T1',
      channelId: 'C1',
      frequency: 'weekly',
      weekday: 5,
      timeOfDay: '14:00',
      timezone: 'America/Chicago',
      anchorDate: null,
      scheduledContentType: 'joke',
      userId: 'U2',
    });

    const config = service.getConfig('T1', 'C1');
    expect(config!.frequency).toBe('weekly');
    expect(config!.scheduledContentType).toBe('joke');
    expect(config!.updatedBy).toBe('U2');
  });

  it('getDueConfigs returns only due configs', () => {
    service.upsertConfig({
      teamId: 'T1',
      channelId: 'C1',
      frequency: 'daily',
      weekday: null,
      timeOfDay: '09:00',
      timezone: 'UTC',
      anchorDate: null,
      scheduledContentType: 'icebreaker',
      userId: 'U1',
    });

    // Far-future check should find nothing
    const farPast = '2020-01-01T00:00:00.000Z';
    expect(service.getDueConfigs(farPast)).toHaveLength(0);

    // Far-future now should find the config
    const farFuture = '2099-01-01T00:00:00.000Z';
    expect(service.getDueConfigs(farFuture)).toHaveLength(1);
  });

  it('advanceNextRun moves next_run_at forward', () => {
    const config = service.upsertConfig({
      teamId: 'T1',
      channelId: 'C1',
      frequency: 'daily',
      weekday: null,
      timeOfDay: '09:00',
      timezone: 'UTC',
      anchorDate: null,
      scheduledContentType: 'funfact',
      userId: 'U1',
    });

    const before = service.getConfig('T1', 'C1')!.nextRunAt;
    service.advanceNextRun(config.id);
    const after = service.getConfig('T1', 'C1')!.nextRunAt;

    expect(DateTime.fromISO(after) > DateTime.fromISO(before)).toBe(true);
  });
});

describe('isValidTimeOfDay', () => {
  it('accepts valid times', () => {
    expect(isValidTimeOfDay('00:00')).toBe(true);
    expect(isValidTimeOfDay('09:30')).toBe(true);
    expect(isValidTimeOfDay('23:59')).toBe(true);
    expect(isValidTimeOfDay('12:00')).toBe(true);
  });

  it('rejects invalid hours', () => {
    expect(isValidTimeOfDay('24:00')).toBe(false);
    expect(isValidTimeOfDay('25:00')).toBe(false);
    expect(isValidTimeOfDay('99:00')).toBe(false);
  });

  it('rejects invalid minutes', () => {
    expect(isValidTimeOfDay('10:60')).toBe(false);
    expect(isValidTimeOfDay('10:99')).toBe(false);
  });

  it('rejects malformed formats', () => {
    expect(isValidTimeOfDay('9:00')).toBe(false);
    expect(isValidTimeOfDay('09:0')).toBe(false);
    expect(isValidTimeOfDay('0900')).toBe(false);
    expect(isValidTimeOfDay('abc')).toBe(false);
    expect(isValidTimeOfDay('')).toBe(false);
  });
});
