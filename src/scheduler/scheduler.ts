import { DateTime } from 'luxon';
import { WebClient } from '@slack/web-api';
import { ContentType, PromptService } from '../prompts/promptService';
import { ScheduleService, ScheduledContentType } from '../schedule/scheduleService';

export interface Scheduler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

const CONTENT_TYPES: ContentType[] = ['icebreaker', 'funfact', 'joke'];

function pickContentType(scheduled: ScheduledContentType): ContentType {
  if (scheduled === 'random') {
    return CONTENT_TYPES[Math.floor(Math.random() * CONTENT_TYPES.length)];
  }
  return scheduled as ContentType;
}

export function createScheduler(
  client: WebClient,
  promptService: PromptService,
  scheduleService: ScheduleService,
  intervalSeconds: number,
): Scheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;

    try {
      const nowUtc = DateTime.utc().toISO()!;
      const dueConfigs = scheduleService.getDueConfigs(nowUtc);

      for (const config of dueConfigs) {
        const contentType = pickContentType(config.scheduledContentType);
        const prompt = promptService.reservePrompt(
          config.teamId,
          config.channelId,
          contentType,
          'scheduled',
        );

        if (prompt) {
          let postSucceeded = false;
          try {
            const result = await client.chat.postMessage({
              channel: config.channelId,
              text: prompt.text,
              blocks: [
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: prompt.text },
                },
              ],
            });
            postSucceeded = true;

            if (result.ts) {
              promptService.updateMessageTs(
                config.teamId,
                config.channelId,
                contentType,
                prompt.id,
                result.ts,
              );
            }
          } catch (err: any) {
            const slackError = err?.data?.error;
            promptService.releaseReservation(config.teamId, config.channelId, contentType, prompt.id);

            if (slackError === 'ratelimited') {
              // Release and retry the same scheduled slot on the next tick.
              console.warn(`Rate limited posting to ${config.channelId}, will retry next tick.`);
              continue;
            } else if (
              slackError === 'not_in_channel' ||
              slackError === 'channel_not_found' ||
              slackError === 'no_permission'
            ) {
              // Release and do not advance next_run_at so the post retries
              // automatically once the bot is invited or permissions are fixed.
              console.warn(`Cannot post to ${config.channelId} (${slackError}), will retry after bot is invited.`);
              continue;
            } else {
              // Unknown error — release and advance to avoid getting permanently stuck.
              console.error(`Error posting to ${config.channelId}:`, slackError || err);
            }
          }

          if (!postSucceeded) {
            scheduleService.advanceNextRun(config.id);
            continue;
          }
        } else {
          try {
            await client.chat.postMessage({
              channel: config.channelId,
              text: `I'm out of fresh ${contentType}s. Ask an icebreaker admin to run \`/icebreaker reset ${contentType}\`.`,
            });
          } catch {
            // Best effort exhaustion notice
          }
        }

        scheduleService.advanceNextRun(config.id);
      }
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(tick, intervalSeconds * 1000);
    console.log(`Scheduler started (interval: ${intervalSeconds}s)`);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
      console.log('Scheduler stopped');
    }
  }

  return { start, stop, tick };
}
