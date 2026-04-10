/**
 * Client Context Service for the Client Briefing Generator.
 * Orchestrates all available IContextAdapter instances to build
 * a unified context timeline for a given client.
 */

import { IContextAdapter, ContextEntry } from '../adapters/types.js';
import { queries } from '../db/index.js';
import { logger } from '../utils/logger.js';

export interface TimelineEvent {
  id: string;
  client_id: string;
  meeting_id: string | null;
  event_type: string;
  event_data: string;
  occurred_at: string;
}

export interface ClientContextOptions {
  since?: Date;
  limit?: number;
}

export class ClientContextService {
  private adapters: IContextAdapter[] = [];

  constructor(adapters?: IContextAdapter[]) {
    if (adapters) {
      this.adapters = adapters;
    }
  }

  /** Register an adapter to be queried for client context. */
  registerAdapter(adapter: IContextAdapter): void {
    this.adapters.push(adapter);
  }

  /** Remove a previously registered adapter by name. */
  removeAdapter(adapterName: string): void {
    this.adapters = this.adapters.filter((a) => a.name !== adapterName);
  }

  /** Get all registered adapter names. */
  getAdapterNames(): string[] {
    return this.adapters.map((a) => a.name);
  }

  /**
   * Query all registered adapters in parallel for a given client,
   * merge results by timestamp, and return a unified context timeline.
   * Individual adapter failures are logged and skipped gracefully.
   */
  async getClientContext(
    clientName: string,
    options?: ClientContextOptions,
  ): Promise<ContextEntry[]> {
    const results = await Promise.allSettled(
      this.adapters.map(async (adapter) => {
        const available = await adapter.isAvailable();
        if (!available) {
          logger.warn(
            `[ClientContextService] Adapter "${adapter.name}" is not available, skipping.`,
          );
          return [] as ContextEntry[];
        }
        return adapter.getClientContext(clientName, options);
      }),
    );

    const entries: ContextEntry[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        entries.push(...result.value);
      } else {
        logger.warn(
          `[ClientContextService] Adapter "${this.adapters[i].name}" failed: ${result.reason}`,
        );
      }
    }

    // Sort by timestamp descending (most recent first)
    entries.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    if (options?.limit && entries.length > options.limit) {
      return entries.slice(0, options.limit);
    }

    return entries;
  }

  /**
   * Query the client_history table for a given client,
   * returning events ordered by occurred_at descending.
   */
  getClientTimeline(clientId: string): TimelineEvent[] {
    return queries.getClientHistory().all(clientId) as TimelineEvent[];
  }
}
