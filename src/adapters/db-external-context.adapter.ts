import type { ContextEntry, IContextAdapter } from './types.js';
import { queries } from '../db/index.js';
import type { ExternalContextRecord } from '../services/google-context.types.js';

export class DbExternalContextAdapter implements IContextAdapter {
  readonly name = 'external_context';

  async initialize(): Promise<void> {
    return Promise.resolve();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async disconnect(): Promise<void> {
    return Promise.resolve();
  }

  async getClientContext(
    clientName: string,
    options?: { since?: Date; limit?: number },
  ): Promise<ContextEntry[]> {
    const limit = options?.limit ?? 50;
    const rows = options?.since
      ? queries.getExternalContextByClientNameSince().all(
          clientName,
          options.since.toISOString(),
          limit,
        )
      : queries.getExternalContextByClientName().all(clientName, limit);

    return (rows as ExternalContextRecord[]).map((row) => ({
      source: row.source,
      type: row.source === 'calendar' ? 'event' : 'message',
      title: row.title,
      content: row.content,
      timestamp: new Date(row.occurred_at),
      metadata: parseMetadata(row.metadata),
    }));
  }
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

