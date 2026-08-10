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
  meetingMcpTimeoutMs: z.coerce.number().int().positive().default(10_000),

  gogBin: z.string().default('gog'),
  gogAccount: z.string().optional(),
  gogGmailLabel: z.string().default('Processes'),
  googleSyncLookbackDays: z.coerce.number().int().positive().default(30),
  googleSyncMaxResults: z.coerce.number().int().positive().default(25),

  linearApiKey: z.string().optional(),
  linearTeamId: z.string().optional(),
  linearWebhookSecret: z.string().optional(),

  anthropicApiKey: z.string().optional(),
  anthropicModel: z.string().default('claude-opus-4-8'),

  // Comma-separated names/emails that identify "our side" when classifying
  // action-item ownership (e.g. "Ramir,ramirleite1987@gmail.com").
  selfIdentifiers: z.string().default(''),

  schedulerEnabled: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  schedulerIntervalMinutes: z.coerce.number().int().positive().default(5),
  briefingLeadMinutes: z.coerce.number().int().positive().default(60),
  reminderLeadMinutes: z.coerce.number().int().positive().default(15),
  linearReconcileIntervalMinutes: z.coerce.number().int().positive().default(30),

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
    meetingMcpTimeoutMs: process.env.MEETING_MCP_TIMEOUT_MS,
    gogBin: process.env.GOG_BIN,
    gogAccount: process.env.GOG_ACCOUNT || undefined,
    gogGmailLabel: process.env.GOG_GMAIL_LABEL,
    googleSyncLookbackDays: process.env.GOOGLE_SYNC_LOOKBACK_DAYS,
    googleSyncMaxResults: process.env.GOOGLE_SYNC_MAX_RESULTS,
    linearApiKey: process.env.LINEAR_API_KEY || undefined,
    linearTeamId: process.env.LINEAR_TEAM_ID || undefined,
    linearWebhookSecret: process.env.LINEAR_WEBHOOK_SECRET || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    anthropicModel: process.env.ANTHROPIC_MODEL,
    selfIdentifiers: process.env.SELF_IDENTIFIERS,
    schedulerEnabled: process.env.SCHEDULER_ENABLED,
    schedulerIntervalMinutes: process.env.SCHEDULER_INTERVAL_MINUTES,
    briefingLeadMinutes: process.env.BRIEFING_LEAD_MINUTES,
    reminderLeadMinutes: process.env.REMINDER_LEAD_MINUTES,
    linearReconcileIntervalMinutes: process.env.LINEAR_RECONCILE_INTERVAL_MINUTES,
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
