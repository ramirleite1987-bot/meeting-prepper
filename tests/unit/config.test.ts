import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load with default values when no env vars are set', async () => {
    delete process.env.PORT;
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_PATH;
    delete process.env.LOG_LEVEL;

    const { config } = await import('../../src/config.js');

    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
    expect(config.databasePath).toBe('./data/meeting-prepper.db');
    expect(config.logLevel).toBe('info');
  });

  it('should use provided env var values', async () => {
    process.env.PORT = '8080';
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_PATH = '/tmp/test.db';
    process.env.LOG_LEVEL = 'debug';
    process.env.OBSIDIAN_VAULT_PATH = '/vault';
    process.env.LINEAR_API_KEY = 'lin-api-xyz';
    process.env.LINEAR_TEAM_ID = 'team-123';

    const { config } = await import('../../src/config.js');

    expect(config.port).toBe(8080);
    expect(config.nodeEnv).toBe('production');
    expect(config.databasePath).toBe('/tmp/test.db');
    expect(config.logLevel).toBe('debug');
    expect(config.obsidianVaultPath).toBe('/vault');
    expect(config.linearApiKey).toBe('lin-api-xyz');
    expect(config.linearTeamId).toBe('team-123');
  });

  it('should coerce PORT string to number', async () => {
    process.env.PORT = '9999';

    const { config } = await import('../../src/config.js');

    expect(config.port).toBe(9999);
    expect(typeof config.port).toBe('number');
  });

  it('should throw on invalid NODE_ENV', async () => {
    process.env.NODE_ENV = 'invalid-env';

    await expect(import('../../src/config.js')).rejects.toThrow('Invalid configuration');
  });

  it('should throw on invalid LOG_LEVEL', async () => {
    process.env.LOG_LEVEL = 'verbose';

    await expect(import('../../src/config.js')).rejects.toThrow('Invalid configuration');
  });

  it('should leave optional fields undefined when not set', async () => {
    delete process.env.OBSIDIAN_VAULT_PATH;
    delete process.env.CALENDAR_ICS_URL;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_WEBHOOK_SECRET;

    const { config } = await import('../../src/config.js');

    expect(config.obsidianVaultPath).toBeUndefined();
    expect(config.calendarIcsUrl).toBeUndefined();
    expect(config.linearApiKey).toBeUndefined();
    expect(config.linearWebhookSecret).toBeUndefined();
  });

  it('should reject invalid CALENDAR_ICS_URL', async () => {
    process.env.CALENDAR_ICS_URL = 'not-a-url';

    await expect(import('../../src/config.js')).rejects.toThrow('Invalid configuration');
  });
});
