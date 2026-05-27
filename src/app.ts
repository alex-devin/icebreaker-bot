import { App, LogLevel } from '@slack/bolt';
import { loadConfig } from './config';
import { getDb } from './store/db';
import { seedPrompts } from './store/seed';
import { createPromptService } from './prompts/promptService';
import { createScheduleService } from './schedule/scheduleService';
import { createScheduler } from './scheduler/scheduler';
import { registerHandlers } from './slack/handlers';

async function main(): Promise<void> {
  const config = loadConfig();

  const db = getDb(config.databasePath);
  seedPrompts(db);

  const promptService = createPromptService(db);
  const scheduleService = createScheduleService(db);

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    signingSecret: config.slackSigningSecret,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  registerHandlers(app, {
    promptService,
    scheduleService,
    adminUserIds: config.adminUserIds,
  });

  const scheduler = createScheduler(
    app.client,
    promptService,
    scheduleService,
    config.schedulerIntervalSeconds,
  );

  await app.start();
  scheduler.start();

  console.log('Versant Icebreaker Bot is running!');

  const shutdown = async () => {
    console.log('Shutting down...');
    scheduler.stop();
    await app.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
