import { App, SlashCommand, RespondFn, SayFn } from '@slack/bolt';
import { DateTime } from 'luxon';
import { ContentType, PromptService, Source } from '../prompts/promptService';
import { ScheduleService, SetupParams, parseWeekday, weekdayName, isValidTimeOfDay, Frequency, ScheduledContentType } from '../schedule/scheduleService';

interface HandlerDeps {
  promptService: PromptService;
  scheduleService: ScheduleService;
  adminUserIds: string[];
}

function isAdmin(userId: string, adminUserIds: string[]): boolean {
  return adminUserIds.includes(userId);
}

function resolveContentType(input: string): ContentType | null {
  const lower = input.toLowerCase().trim();
  if (lower === 'icebreaker' || lower === 'prompt') return 'icebreaker';
  if (lower === 'funfact') return 'funfact';
  if (lower === 'joke' || lower === 'joketime') return 'joke';
  return null;
}

const HELP_TEXT = `*Icebreaker Bot Commands:*
• \`/icebreaker\` — Post a random icebreaker
• \`/icebreaker funfact\` — Post a fun fact
• \`/icebreaker joketime\` or \`/icebreaker joke\` — Post a joke
• \`/icebreaker status\` — Show schedule and remaining prompts
• \`/icebreaker setup <frequency> [weekday] <time> <timezone> <content_type> [anchor_date]\` — Configure schedule (admin)
• \`/icebreaker reset <type|all>\` — Reset prompt memory (admin)
• \`/icebreaker help\` — Show this help

*Setup examples:*
• \`/icebreaker setup daily 09:00 America/New_York random\`
• \`/icebreaker setup weekly thursday 10:00 America/New_York icebreaker\`
• \`/icebreaker setup biweekly thursday 10:00 America/New_York joke 2026-05-28\`

*Mentions:*
• \`@IcebreakerBot prompt\` or \`@IcebreakerBot icebreaker\` — Icebreaker
• \`@IcebreakerBot funfact\` — Fun fact
• \`@IcebreakerBot joke\` — Joke`;

async function postPrompt(
  teamId: string,
  channelId: string,
  contentType: ContentType,
  source: Source,
  userId: string | undefined,
  say: SayFn,
  promptService: PromptService,
): Promise<void> {
  const prompt = promptService.reservePrompt(teamId, channelId, contentType, source, userId);

  if (!prompt) {
    await say({
      text: `I'm out of fresh ${contentType}s. Ask an icebreaker admin to run \`/icebreaker reset ${contentType}\`.`,
    });
    return;
  }

  let result;
  try {
    result = await say({
      text: prompt.text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: prompt.text },
        },
      ],
    });
  } catch (err) {
    promptService.releaseReservation(teamId, channelId, contentType, prompt.id);
    throw err;
  }

  const messageTs = typeof result === 'object' && 'ts' in result ? result.ts : undefined;
  if (messageTs) {
    promptService.updateMessageTs(teamId, channelId, contentType, prompt.id, messageTs);
  }
}

export function registerHandlers(app: App, deps: HandlerDeps): void {
  const { promptService, scheduleService, adminUserIds } = deps;

  app.command('/icebreaker', async ({ command, ack, respond, say }) => {
    await ack();

    const text = command.text.trim().toLowerCase();
    const teamId = command.team_id;
    const channelId = command.channel_id;
    const userId = command.user_id;

    if (!text || text === 'icebreaker') {
      await postPrompt(teamId, channelId, 'icebreaker', 'manual', userId, say, promptService);
      return;
    }

    if (text === 'funfact') {
      await postPrompt(teamId, channelId, 'funfact', 'manual', userId, say, promptService);
      return;
    }

    if (text === 'joke' || text === 'joketime') {
      await postPrompt(teamId, channelId, 'joke', 'manual', userId, say, promptService);
      return;
    }

    if (text === 'help') {
      await respond({ text: HELP_TEXT, response_type: 'ephemeral' });
      return;
    }

    if (text === 'status') {
      await handleStatus(teamId, channelId, respond, promptService, scheduleService);
      return;
    }

    if (text.startsWith('setup')) {
      if (!isAdmin(userId, adminUserIds)) {
        await respond({ text: 'Only icebreaker admins can configure schedules.', response_type: 'ephemeral' });
        return;
      }
      await handleSetup(text, teamId, channelId, userId, respond, scheduleService);
      return;
    }

    if (text.startsWith('reset')) {
      if (!isAdmin(userId, adminUserIds)) {
        await respond({ text: 'Only icebreaker admins can reset prompt memory.', response_type: 'ephemeral' });
        return;
      }
      await handleReset(text, teamId, channelId, respond, promptService);
      return;
    }

    await respond({ text: `Unknown command: \`${command.text}\`. Try \`/icebreaker help\`.`, response_type: 'ephemeral' });
  });

  app.event('app_mention', async ({ event, context, say }) => {
    const text = event.text.replace(/<@[^>]+>/g, '').trim().toLowerCase();
    const teamId = context.teamId ?? (event as any).team ?? '';
    const channelId = event.channel;
    const userId = event.user;

    const contentType = resolveContentType(text);
    if (contentType) {
      await postPrompt(teamId, channelId, contentType, 'mention', userId, say, promptService);
    } else {
      await say({
        text: 'Try mentioning me with: `prompt`, `funfact`, or `joke`.',
      });
    }
  });
}

async function handleStatus(
  teamId: string,
  channelId: string,
  respond: RespondFn,
  promptService: PromptService,
  scheduleService: ScheduleService,
): Promise<void> {
  const config = scheduleService.getConfig(teamId, channelId);

  const icebreakerRemaining = promptService.getRemainingCount(teamId, channelId, 'icebreaker');
  const funfactRemaining = promptService.getRemainingCount(teamId, channelId, 'funfact');
  const jokeRemaining = promptService.getRemainingCount(teamId, channelId, 'joke');

  const icebreakerTotal = promptService.getTotalCount('icebreaker');
  const funfactTotal = promptService.getTotalCount('funfact');
  const jokeTotal = promptService.getTotalCount('joke');

  let statusText = `*Remaining prompts for this channel:*\n`;
  statusText += `• Icebreakers: ${icebreakerRemaining}/${icebreakerTotal}\n`;
  statusText += `• Fun facts: ${funfactRemaining}/${funfactTotal}\n`;
  statusText += `• Jokes: ${jokeRemaining}/${jokeTotal}\n`;

  if (config) {
    const nextRunLocal = DateTime.fromISO(config.nextRunAt, { zone: 'utc' }).setZone(config.timezone);
    statusText += `\n*Schedule:*\n`;
    statusText += `• Frequency: ${config.frequency}`;
    if (config.weekday) statusText += ` (${weekdayName(config.weekday)})`;
    statusText += `\n`;
    statusText += `• Time: ${config.timeOfDay} ${config.timezone}\n`;
    statusText += `• Content: ${config.scheduledContentType}\n`;
    statusText += `• Next run: ${nextRunLocal.toFormat('yyyy-MM-dd HH:mm ZZZZ')}\n`;
  } else {
    statusText += `\n_No schedule configured for this channel._`;
  }

  await respond({ text: statusText, response_type: 'ephemeral' });
}

async function handleSetup(
  text: string,
  teamId: string,
  channelId: string,
  userId: string,
  respond: RespondFn,
  scheduleService: ScheduleService,
): Promise<void> {
  // setup <frequency> [weekday] <time> <timezone> <content_type> [anchor_date]
  const parts = text.replace('setup', '').trim().split(/\s+/);

  if (parts.length < 3) {
    await respond({
      text: 'Usage: `/icebreaker setup <daily|weekly|biweekly> [weekday] <HH:MM> <timezone> <icebreaker|funfact|joke|random> [anchor_date]`',
      response_type: 'ephemeral',
    });
    return;
  }

  const frequency = parts[0] as Frequency;
  if (!['daily', 'weekly', 'biweekly'].includes(frequency)) {
    await respond({ text: `Invalid frequency: \`${parts[0]}\`. Use daily, weekly, or biweekly.`, response_type: 'ephemeral' });
    return;
  }

  let idx = 1;
  let weekday: number | null = null;

  if (frequency === 'weekly' || frequency === 'biweekly') {
    weekday = parseWeekday(parts[idx]);
    if (weekday === null) {
      await respond({ text: `Invalid weekday: \`${parts[idx]}\`. Use monday, tuesday, etc.`, response_type: 'ephemeral' });
      return;
    }
    idx++;
  }

  const timeOfDay = parts[idx];
  if (!isValidTimeOfDay(timeOfDay)) {
    await respond({ text: `Invalid time: \`${timeOfDay}\`. Use HH:MM (24-hour, 00:00–23:59).`, response_type: 'ephemeral' });
    return;
  }
  idx++;

  const timezone = parts[idx];
  if (!DateTime.now().setZone(timezone).isValid) {
    await respond({ text: `Invalid timezone: \`${timezone}\`.`, response_type: 'ephemeral' });
    return;
  }
  idx++;

  const contentTypeInput = parts[idx] || 'icebreaker';
  const validContentTypes: ScheduledContentType[] = ['icebreaker', 'funfact', 'joke', 'random'];
  if (!validContentTypes.includes(contentTypeInput as ScheduledContentType)) {
    await respond({ text: `Invalid content type: \`${contentTypeInput}\`. Use icebreaker, funfact, joke, or random.`, response_type: 'ephemeral' });
    return;
  }
  idx++;

  let anchorDate: string | null = null;
  if (frequency === 'biweekly') {
    anchorDate = parts[idx] || null;
    if (!anchorDate) {
      await respond({ text: 'Biweekly schedule requires an anchor date (YYYY-MM-DD).', response_type: 'ephemeral' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
      await respond({ text: `Invalid anchor date format: \`${anchorDate}\`. Use YYYY-MM-DD.`, response_type: 'ephemeral' });
      return;
    }
  }

  const params: SetupParams = {
    teamId,
    channelId,
    frequency,
    weekday,
    timeOfDay,
    timezone,
    anchorDate,
    scheduledContentType: contentTypeInput as ScheduledContentType,
    userId,
  };

  try {
    const config = scheduleService.upsertConfig(params);
    const nextRunLocal = DateTime.fromISO(config.nextRunAt, { zone: 'utc' }).setZone(config.timezone);
    await respond({
      text: `Schedule configured! Next ${config.scheduledContentType} post: ${nextRunLocal.toFormat('yyyy-MM-dd HH:mm ZZZZ')}`,
      response_type: 'ephemeral',
    });
  } catch (err: any) {
    await respond({ text: `Error configuring schedule: ${err.message}`, response_type: 'ephemeral' });
  }
}

async function handleReset(
  text: string,
  teamId: string,
  channelId: string,
  respond: RespondFn,
  promptService: PromptService,
): Promise<void> {
  const arg = text.replace('reset', '').trim();

  const types: ContentType[] = [];
  if (!arg || arg === 'icebreaker') {
    types.push('icebreaker');
  } else if (arg === 'funfact') {
    types.push('funfact');
  } else if (arg === 'joke') {
    types.push('joke');
  } else if (arg === 'all') {
    types.push('icebreaker', 'funfact', 'joke');
  } else {
    await respond({ text: `Unknown reset target: \`${arg}\`. Use icebreaker, funfact, joke, or all.`, response_type: 'ephemeral' });
    return;
  }

  for (const t of types) {
    promptService.resetMemory(teamId, channelId, t);
  }

  await respond({
    text: `Reset complete for: ${types.join(', ')}. Fresh prompts are available again!`,
    response_type: 'ephemeral',
  });
}
