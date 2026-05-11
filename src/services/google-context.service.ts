import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb, queries } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { buildAliasTerms } from './client-aliases.js';
import { GogExecutor } from './gog-executor.service.js';
import type {
  ClientRecord,
  GoogleContextItem,
  GoogleSyncResult,
} from './google-context.types.js';

interface GogGmailMessage {
  id?: string;
  threadId?: string;
  subject?: string;
  from?: string;
  to?: string | string[];
  date?: string;
  snippet?: string;
  body?: string;
  text?: string;
  [key: string]: unknown;
}

interface GogCalendarEvent {
  id?: string;
  summary?: string;
  title?: string;
  description?: string;
  start?: string | { dateTime?: string; date?: string };
  end?: string | { dateTime?: string; date?: string };
  attendees?: unknown[];
  htmlLink?: string;
  [key: string]: unknown;
}

export interface GoogleSyncOptions {
  clientId?: string;
  lookbackDays?: number;
}

export class GoogleContextService {
  private readonly log = logger.child('GoogleContextService');

  constructor(private readonly gog = new GogExecutor()) {}

  async getStatus(): Promise<Awaited<ReturnType<GogExecutor['status']>>> {
    return this.gog.status();
  }

  async sync(options: GoogleSyncOptions = {}): Promise<GoogleSyncResult> {
    const clients = this.getClients(options.clientId);
    const lookbackDays = options.lookbackDays ?? config.googleSyncLookbackDays;
    const result: GoogleSyncResult = {
      imported: 0,
      clientsChecked: clients.length,
      errors: [],
    };

    for (const client of clients) {
      try {
        const clientResult = await this.syncClient(client, lookbackDays);
        result.imported += clientResult.imported;
        result.errors.push(...clientResult.errors);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ source: 'google', message, clientId: client.id });
        this.log.warn('Google sync failed for client', { clientId: client.id, message });
      }
    }

    return result;
  }

  buildGmailQuery(client: ClientRecord, lookbackDays: number): string {
    const terms = buildAliasTerms(client)
      .map((term) => `"${term.replace(/"/g, '\\"')}"`)
      .join(' OR ');
    const aliasClause = terms ? ` (${terms})` : '';
    return `label:${config.gogGmailLabel} newer_than:${lookbackDays}d${aliasClause}`;
  }

  private getClients(clientId?: string): ClientRecord[] {
    if (clientId) {
      const client = queries.getClientById().get(clientId) as ClientRecord | undefined;
      return client ? [client] : [];
    }

    return queries.getAllClients().all() as ClientRecord[];
  }

  private async syncClient(
    client: ClientRecord,
    lookbackDays: number,
  ): Promise<Pick<GoogleSyncResult, 'imported' | 'errors'>> {
    const [gmailResult, calendarResult] = await Promise.allSettled([
      this.fetchGmailContext(client, lookbackDays),
      this.fetchCalendarContext(client, lookbackDays),
    ]);

    const items: GoogleContextItem[] = [];
    const errors: GoogleSyncResult['errors'] = [];
    if (gmailResult.status === 'fulfilled') {
      items.push(...gmailResult.value);
    } else {
      const message = errorMessage(gmailResult.reason);
      errors.push({ source: 'gmail', message, clientId: client.id });
      this.log.warn('Gmail sync failed', { clientId: client.id, error: message });
    }

    if (calendarResult.status === 'fulfilled') {
      items.push(...calendarResult.value);
    } else {
      const message = errorMessage(calendarResult.reason);
      errors.push({ source: 'calendar', message, clientId: client.id });
      this.log.warn('Calendar sync failed', { clientId: client.id, error: message });
    }

    return {
      imported: this.persistItems(items),
      errors,
    };
  }

  private async fetchGmailContext(
    client: ClientRecord,
    lookbackDays: number,
  ): Promise<GoogleContextItem[]> {
    const messages = await this.gog.runJson<GogGmailMessage[]>([
      'gmail',
      'messages',
      'search',
      this.buildGmailQuery(client, lookbackDays),
      '--include-body',
      '--full',
    ]);

    return ensureArray(messages).slice(0, config.googleSyncMaxResults).map((message) => ({
      clientId: client.id,
      source: 'gmail',
      externalId: String(message.id ?? message.threadId ?? randomUUID()),
      title: String(message.subject ?? 'Gmail message'),
      content: String(message.body ?? message.text ?? message.snippet ?? ''),
      occurredAt: parseDate(message.date),
      metadata: {
        from: message.from,
        to: message.to,
        threadId: message.threadId,
      },
    }));
  }

  private async fetchCalendarContext(
    client: ClientRecord,
    lookbackDays: number,
  ): Promise<GoogleContextItem[]> {
    const now = new Date();
    const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + lookbackDays * 24 * 60 * 60 * 1000);
    const events = await this.gog.runJson<GogCalendarEvent[]>([
      'calendar',
      'events',
      'primary',
      '--from',
      from.toISOString(),
      '--to',
      to.toISOString(),
    ]);

    const terms = buildAliasTerms(client).map((term) => term.toLowerCase());
    return ensureArray(events)
      .filter((event) => matchesEvent(event, terms))
      .slice(0, config.googleSyncMaxResults)
      .map((event) => ({
        clientId: client.id,
        source: 'calendar',
        externalId: String(event.id ?? randomUUID()),
        title: String(event.summary ?? event.title ?? 'Calendar event'),
        content: String(event.description ?? ''),
        occurredAt: parseDate(extractEventDate(event.start)),
        metadata: {
          attendees: event.attendees,
          htmlLink: event.htmlLink,
          end: extractEventDate(event.end),
        },
      }));
  }

  private persistItems(items: GoogleContextItem[]): number {
    if (items.length === 0) {
      return 0;
    }

    const db = getDb();
    const transaction = db.transaction(() => {
      for (const item of items) {
        queries.upsertExternalContext().run({
          id: randomUUID(),
          clientId: item.clientId,
          source: item.source,
          externalId: item.externalId,
          title: item.title,
          content: item.content,
          occurredAt: item.occurredAt.toISOString(),
          metadata: JSON.stringify(item.metadata),
        });
      }
    });

    transaction();
    return items.length;
  }
}

function ensureArray<T>(value: T[] | { items?: T[] } | { messages?: T[] } | { events?: T[] }): T[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === 'object') {
    const record = value as { items?: T[]; messages?: T[]; events?: T[] };
    return record.items ?? record.messages ?? record.events ?? [];
  }

  return [];
}

function extractEventDate(value: GogCalendarEvent['start']): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  return value.dateTime ?? value.date;
}

function matchesEvent(event: GogCalendarEvent, terms: string[]): boolean {
  if (terms.length === 0) {
    return true;
  }

  const haystack = JSON.stringify({
    title: event.summary ?? event.title,
    description: event.description,
    attendees: event.attendees,
  }).toLowerCase();

  return terms.some((term) => haystack.includes(term));
}

function parseDate(value: unknown): Date {
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
