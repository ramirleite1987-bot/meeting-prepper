import { randomUUID } from 'node:crypto';
import { KrispAdapter } from '../adapters/krisp.adapter.js';
import { GranolaAdapter } from '../adapters/granola.adapter.js';
import type { ContextEntry, IMeetingAdapter, MeetingNotes, MeetingSummary } from '../adapters/types.js';
import { queries } from '../db/index.js';
import { logger } from '../utils/logger.js';

export type MeetingContextSource = 'krisp' | 'granola';

export interface ContextCandidate extends MeetingSummary {
  summary?: string;
}

export interface ContextSearchOptions {
  source: MeetingContextSource;
  query?: string;
  tags?: string[];
  limit?: number;
}

export interface ContextSelection {
  source: MeetingContextSource;
  externalId: string;
}

export class MeetingContextService {
  private readonly log = logger.child('MeetingContextService');
  private readonly adapters: Record<MeetingContextSource, IMeetingAdapter>;

  constructor(adapters?: Partial<Record<MeetingContextSource, IMeetingAdapter>>) {
    this.adapters = {
      krisp: adapters?.krisp ?? new KrispAdapter(),
      granola: adapters?.granola ?? new GranolaAdapter(),
    };
  }

  async searchCandidates(options: ContextSearchOptions): Promise<ContextCandidate[]> {
    const adapter = this.adapters[options.source];
    await this.initializeAdapter(adapter);
    if (!(await adapter.isAvailable())) {
      return [];
    }

    const query = this.buildQuery(options.query, options.source === 'krisp' ? options.tags : undefined);
    return adapter.searchMeetings(query, { limit: options.limit ?? 10 });
  }

  async attachSelections(meetingId: string, selections: ContextSelection[]): Promise<number> {
    let attached = 0;
    for (const selection of selections) {
      const adapter = this.adapters[selection.source];
      await this.initializeAdapter(adapter);
      if (!(await adapter.isAvailable())) {
        continue;
      }

      const notes = await adapter.getMeetingNotes(selection.externalId);
      if (!notes) {
        continue;
      }

      this.attachNotes(meetingId, notes);
      attached += 1;
    }
    return attached;
  }

  getAttachedContextEntries(meetingId: string): ContextEntry[] {
    const rows = queries.getMeetingSourcesByMeeting().all(meetingId) as Array<{
      source: string;
      external_id: string | null;
      summary: string | null;
      decisions: string | null;
      risks: string | null;
      raw_data: string | null;
      fetched_at: string;
    }>;

    return rows.map((row) => ({
      source: row.source,
      type: 'note',
      title: `${row.source} meeting context`,
      content: row.summary ?? '',
      timestamp: new Date(row.fetched_at),
      metadata: {
        externalId: row.external_id,
        decisions: parseJsonArray(row.decisions),
        risks: parseJsonArray(row.risks),
        raw: parseJsonObject(row.raw_data),
      },
    }));
  }

  private async initializeAdapter(adapter: IMeetingAdapter): Promise<void> {
    try {
      await adapter.initialize();
    } catch (error) {
      this.log.warn('Meeting context adapter initialization failed', {
        source: adapter.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private attachNotes(meetingId: string, notes: MeetingNotes): void {
    queries.upsertMeetingSource().run({
      id: randomUUID(),
      meetingId,
      source: notes.source,
      externalId: notes.meetingId,
      summary: notes.summary,
      decisions: JSON.stringify(extractPrefixedPoints(notes.keyPoints, 'Decision: ')),
      risks: JSON.stringify(extractPrefixedPoints(notes.keyPoints, 'Risk: ')),
      rawData: JSON.stringify({
        title: notes.title,
        date: notes.date.toISOString(),
        attendees: notes.attendees,
        keyPoints: notes.keyPoints,
        metadata: notes.metadata,
      }),
    });
  }

  private buildQuery(query?: string, tags?: string[]): string {
    const parts = [query?.trim(), ...(tags ?? []).map((tag) => tag.trim()).filter(Boolean)];
    return parts.filter(Boolean).join(' ');
  }
}

function extractPrefixedPoints(points: string[], prefix: string): string[] {
  return points
    .filter((point) => point.startsWith(prefix))
    .map((point) => point.slice(prefix.length));
}

function parseJsonArray(value: string | null): string[] {
  const parsed = parseJsonObject(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function parseJsonObject(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

