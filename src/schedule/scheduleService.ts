import Database from 'better-sqlite3';
import { DateTime } from 'luxon';

export type Frequency = 'daily' | 'weekly' | 'biweekly';
export type ScheduledContentType = 'icebreaker' | 'funfact' | 'joke' | 'random';

export interface ChannelConfig {
  id: number;
  teamId: string;
  channelId: string;
  frequency: Frequency;
  weekday: number | null;
  timeOfDay: string;
  timezone: string;
  anchorDate: string | null;
  scheduledContentType: ScheduledContentType;
  nextRunAt: string;
  active: boolean;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface SetupParams {
  teamId: string;
  channelId: string;
  frequency: Frequency;
  weekday: number | null;
  timeOfDay: string;
  timezone: string;
  anchorDate: string | null;
  scheduledContentType: ScheduledContentType;
  userId: string;
}

export interface ScheduleService {
  upsertConfig(params: SetupParams): ChannelConfig;
  getConfig(teamId: string, channelId: string): ChannelConfig | null;
  getDueConfigs(nowUtc: string): ChannelConfig[];
  advanceNextRun(configId: number): void;
  deactivateConfig(teamId: string, channelId: string): void;
}

const WEEKDAY_NAMES: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

export function parseWeekday(input: string): number | null {
  const lower = input.toLowerCase();
  return WEEKDAY_NAMES[lower] ?? null;
}

export function isValidTimeOfDay(input: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(input)) return false;
  const [h, m] = input.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export function weekdayName(num: number): string {
  const names = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return names[num] || 'Unknown';
}

export function computeNextRun(
  frequency: Frequency,
  weekday: number | null,
  timeOfDay: string,
  timezone: string,
  anchorDate: string | null,
  afterUtc?: string,
): string {
  const [hour, minute] = timeOfDay.split(':').map(Number);
  const now = afterUtc ? DateTime.fromISO(afterUtc, { zone: 'utc' }) : DateTime.utc();

  if (frequency === 'daily') {
    let candidate = now.setZone(timezone).set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= now.setZone(timezone)) {
      candidate = candidate.plus({ days: 1 });
    }
    return candidate.toUTC().toISO()!;
  }

  if (frequency === 'weekly') {
    if (weekday === null) throw new Error('weekday required for weekly schedule');
    let candidate = now.setZone(timezone).set({ hour, minute, second: 0, millisecond: 0 });
    while (candidate.weekday !== weekday || candidate <= now.setZone(timezone)) {
      candidate = candidate.plus({ days: 1 });
    }
    return candidate.toUTC().toISO()!;
  }

  if (frequency === 'biweekly') {
    if (weekday === null) throw new Error('weekday required for biweekly schedule');
    if (!anchorDate) throw new Error('anchor_date required for biweekly schedule');

    const anchor = DateTime.fromISO(anchorDate, { zone: timezone }).set({
      hour, minute, second: 0, millisecond: 0,
    });

    if (!anchor.isValid) throw new Error(`Invalid anchor date: ${anchorDate}`);
    if (anchor.weekday !== weekday) {
      throw new Error(
        `Anchor date ${anchorDate} is a ${weekdayName(anchor.weekday)}, not ${weekdayName(weekday)}`,
      );
    }

    let candidate = anchor;
    const localNow = now.setZone(timezone);

    while (candidate <= localNow) {
      candidate = candidate.plus({ weeks: 2 });
    }
    return candidate.toUTC().toISO()!;
  }

  throw new Error(`Unknown frequency: ${frequency}`);
}

export function createScheduleService(db: Database.Database): ScheduleService {
  function upsertConfig(params: SetupParams): ChannelConfig {
    const nextRunAt = computeNextRun(
      params.frequency,
      params.weekday,
      params.timeOfDay,
      params.timezone,
      params.anchorDate,
    );

    db.prepare(`
      INSERT INTO channel_configs (team_id, channel_id, frequency, weekday, time_of_day, timezone, anchor_date, scheduled_content_type, next_run_at, active, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(team_id, channel_id)
      DO UPDATE SET
        frequency = excluded.frequency,
        weekday = excluded.weekday,
        time_of_day = excluded.time_of_day,
        timezone = excluded.timezone,
        anchor_date = excluded.anchor_date,
        scheduled_content_type = excluded.scheduled_content_type,
        next_run_at = excluded.next_run_at,
        active = 1,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(
      params.teamId,
      params.channelId,
      params.frequency,
      params.weekday,
      params.timeOfDay,
      params.timezone,
      params.anchorDate,
      params.scheduledContentType,
      nextRunAt,
      params.userId,
      params.userId,
    );

    return getConfig(params.teamId, params.channelId)!;
  }

  function getConfig(teamId: string, channelId: string): ChannelConfig | null {
    const row = db.prepare(
      'SELECT * FROM channel_configs WHERE team_id = ? AND channel_id = ? AND active = 1',
    ).get(teamId, channelId) as any;

    if (!row) return null;

    return {
      id: row.id,
      teamId: row.team_id,
      channelId: row.channel_id,
      frequency: row.frequency,
      weekday: row.weekday,
      timeOfDay: row.time_of_day,
      timezone: row.timezone,
      anchorDate: row.anchor_date,
      scheduledContentType: row.scheduled_content_type,
      nextRunAt: row.next_run_at,
      active: !!row.active,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
    };
  }

  function getDueConfigs(nowUtc: string): ChannelConfig[] {
    const rows = db.prepare(
      'SELECT * FROM channel_configs WHERE active = 1 AND next_run_at <= ?',
    ).all(nowUtc) as any[];

    return rows.map((row) => ({
      id: row.id,
      teamId: row.team_id,
      channelId: row.channel_id,
      frequency: row.frequency,
      weekday: row.weekday,
      timeOfDay: row.time_of_day,
      timezone: row.timezone,
      anchorDate: row.anchor_date,
      scheduledContentType: row.scheduled_content_type,
      nextRunAt: row.next_run_at,
      active: !!row.active,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
    }));
  }

  function advanceNextRun(configId: number): void {
    const row = db.prepare('SELECT * FROM channel_configs WHERE id = ?').get(configId) as any;
    if (!row) return;

    const nextRunAt = computeNextRun(
      row.frequency,
      row.weekday,
      row.time_of_day,
      row.timezone,
      row.anchor_date,
      row.next_run_at,
    );

    db.prepare('UPDATE channel_configs SET next_run_at = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(nextRunAt, configId);
  }

  function deactivateConfig(teamId: string, channelId: string): void {
    db.prepare(
      'UPDATE channel_configs SET active = 0, updated_at = datetime(\'now\') WHERE team_id = ? AND channel_id = ?',
    ).run(teamId, channelId);
  }

  return {
    upsertConfig,
    getConfig,
    getDueConfigs,
    advanceNextRun,
    deactivateConfig,
  };
}
