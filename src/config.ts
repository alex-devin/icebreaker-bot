export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  adminUserIds: string[];
  databasePath: string;
  schedulerIntervalSeconds: number;
}

export function loadConfig(): Config {
  const slackBotToken = requireEnv('SLACK_BOT_TOKEN');
  const slackAppToken = requireEnv('SLACK_APP_TOKEN');
  const slackSigningSecret = requireEnv('SLACK_SIGNING_SECRET');

  const adminUserIds = (process.env.ICEBREAKER_ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const databasePath = process.env.DATABASE_PATH || './icebreaker.db';
  const schedulerIntervalSeconds = parseInt(process.env.SCHEDULER_INTERVAL_SECONDS || '30', 10);

  return {
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    adminUserIds,
    databasePath,
    schedulerIntervalSeconds,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
