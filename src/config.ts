import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  databasePath: z.string().default('./data/meeting-prepper.db'),

  obsidianVaultPath: z.string().optional(),

  calendarIcsUrl: z.string().url().optional(),

  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),

  githubToken: z.string().optional(),
  githubRepos: z.string().optional(),

  krispMcpServerUrl: z.string().url().optional(),

  granolaMcpServerUrl: z.string().url().optional(),

  linearApiKey: z.string().optional(),
  linearTeamId: z.string().optional(),
  linearWebhookSecret: z.string().optional(),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const raw = {
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    databasePath: process.env.DATABASE_PATH,
    obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH || undefined,
    calendarIcsUrl: process.env.CALENDAR_ICS_URL || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    githubToken: process.env.GITHUB_TOKEN || undefined,
    githubRepos: process.env.GITHUB_REPOS || undefined,
    krispMcpServerUrl: process.env.KRISP_MCP_SERVER_URL || undefined,
    granolaMcpServerUrl: process.env.GRANOLA_MCP_SERVER_URL || undefined,
    linearApiKey: process.env.LINEAR_API_KEY || undefined,
    linearTeamId: process.env.LINEAR_TEAM_ID || undefined,
    linearWebhookSecret: process.env.LINEAR_WEBHOOK_SECRET || undefined,
    logLevel: process.env.LOG_LEVEL,
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${formatted}`);
  }

  return result.data;
}

export const config = loadConfig();
