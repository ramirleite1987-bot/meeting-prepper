import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  databasePath: z.string().default('./data/meeting-prepper.db'),

  obsidianVaultPath: z.string().optional(),

  calendarIcsUrl: z.string().url().optional(),

  krispMcpServerUrl: z.string().url().optional(),

  granolaMcpServerUrl: z.string().url().optional(),

  gogBin: z.string().default('gog'),
  gogAccount: z.string().optional(),
  gogGmailLabel: z.string().default('Processes'),
  googleSyncLookbackDays: z.coerce.number().int().positive().default(30),
  googleSyncMaxResults: z.coerce.number().int().positive().default(25),

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
    krispMcpServerUrl: process.env.KRISP_MCP_SERVER_URL || undefined,
    granolaMcpServerUrl: process.env.GRANOLA_MCP_SERVER_URL || undefined,
    gogBin: process.env.GOG_BIN,
    gogAccount: process.env.GOG_ACCOUNT || undefined,
    gogGmailLabel: process.env.GOG_GMAIL_LABEL,
    googleSyncLookbackDays: process.env.GOOGLE_SYNC_LOOKBACK_DAYS,
    googleSyncMaxResults: process.env.GOOGLE_SYNC_MAX_RESULTS,
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
