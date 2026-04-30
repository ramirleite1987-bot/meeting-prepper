import { getDb } from '../db/index.js';
import { logger } from './logger.js';

const log = logger.child('TokenManager');

interface StoredToken {
  service: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TokenInfo {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

type RefreshFn = (refreshToken: string) => Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
}>;

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

export class TokenManager {
  private refreshFunctions = new Map<string, RefreshFn>();

  constructor() {
    this.ensureTable();
  }

  private ensureTable(): void {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        service TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  registerRefreshFunction(service: string, fn: RefreshFn): void {
    this.refreshFunctions.set(service, fn);
  }

  storeToken(
    service: string,
    accessToken: string,
    refreshToken?: string,
    expiresInSeconds?: number,
  ): void {
    const db = getDb();
    const expiresAt = expiresInSeconds
      ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
      : null;

    db.prepare(
      `
      INSERT INTO oauth_tokens (service, access_token, refresh_token, expires_at)
      VALUES (@service, @accessToken, @refreshToken, @expiresAt)
      ON CONFLICT(service) DO UPDATE SET
        access_token = @accessToken,
        refresh_token = COALESCE(@refreshToken, oauth_tokens.refresh_token),
        expires_at = @expiresAt,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run({
      service,
      accessToken,
      refreshToken: refreshToken ?? null,
      expiresAt,
    });

    log.debug('Token stored', { service, expiresAt });
  }

  async getValidToken(service: string): Promise<string | null> {
    const token = this.getStoredToken(service);
    if (!token) {
      return null;
    }

    if (this.isExpiringSoon(token.expiresAt)) {
      const refreshed = await this.refreshToken(service, token.refreshToken);
      return refreshed ? refreshed.accessToken : null;
    }

    return token.accessToken;
  }

  private getStoredToken(service: string): TokenInfo | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM oauth_tokens WHERE service = ?').get(service) as
      | StoredToken
      | undefined;

    if (!row) {
      return null;
    }

    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    };
  }

  private isExpiringSoon(expiresAt: Date | null): boolean {
    if (!expiresAt) {
      return false;
    }
    return expiresAt.getTime() - Date.now() < TOKEN_REFRESH_BUFFER_MS;
  }

  private async refreshToken(
    service: string,
    refreshToken: string | null,
  ): Promise<TokenInfo | null> {
    if (!refreshToken) {
      log.warn('No refresh token available', { service });
      return null;
    }

    const refreshFn = this.refreshFunctions.get(service);
    if (!refreshFn) {
      log.warn('No refresh function registered', { service });
      return null;
    }

    try {
      log.info('Refreshing token', { service });
      const result = await refreshFn(refreshToken);
      this.storeToken(service, result.accessToken, result.refreshToken, result.expiresInSeconds);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? refreshToken,
        expiresAt: result.expiresInSeconds
          ? new Date(Date.now() + result.expiresInSeconds * 1000)
          : null,
      };
    } catch (error) {
      log.error('Token refresh failed', {
        service,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  removeToken(service: string): void {
    const db = getDb();
    db.prepare('DELETE FROM oauth_tokens WHERE service = ?').run(service);
    log.info('Token removed', { service });
  }
}

/**
 * Process-wide singleton. Register refresh callbacks once at startup with
 * `tokenManager.registerRefreshFunction(service, fn)`, then call
 * `getValidToken(service)` from request paths. Tokens are persisted in
 * SQLite; do NOT construct a second TokenManager instance — it would
 * duplicate refresh logic and race on writes.
 */
export const tokenManager = new TokenManager();
