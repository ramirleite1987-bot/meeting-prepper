/**
 * Extraction Service for the Client Briefing Generator.
 * Orchestrates Krisp and Granola adapters to fetch post-meeting data,
 * merges summaries, deduplicates action items, and stores results.
 */

import { randomUUID, createHash } from 'node:crypto';
import { KrispAdapter } from '../adapters/krisp.adapter.js';
import { GranolaAdapter } from '../adapters/granola.adapter.js';
import type { IMeetingAdapter, MeetingNotes, ActionItem } from '../adapters/types.js';
import { getDb, queries } from '../db/index.js';
import { logger } from '../utils/logger.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface ExtractionResult {
  meetingId: string;
  mergedSummary: string;
  decisions: string[];
  risks: string[];
  actionItems: ActionItem[];
  sources: SourceResult[];
  errors: SourceError[];
}

interface SourceResult {
  source: string;
  externalId: string;
  summary: string;
  decisions: string[];
  risks: string[];
  actionItems: ActionItem[];
}

interface SourceError {
  source: string;
  error: string;
}

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class ExtractionService {
  private readonly log = logger.child('ExtractionService');
  private adapters: IMeetingAdapter[];

  constructor(adapters?: IMeetingAdapter[]) {
    this.adapters = adapters ?? [new KrispAdapter(), new GranolaAdapter()];
  }

  /**
   * Extract post-meeting data from all configured adapters,
   * merge results, deduplicate action items, and persist to database.
   */
  async extract(meetingId: string): Promise<ExtractionResult> {
    this.log.info('Starting extraction', { meetingId });

    await this.initializeAdapters();

    const sourceResults: SourceResult[] = [];
    const errors: SourceError[] = [];

    // Fetch from all adapters concurrently, handling partial failures
    const results = await Promise.allSettled(
      this.adapters.map((adapter) => this.fetchFromAdapter(adapter, meetingId)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        sourceResults.push(result.value);
      } else if (result.status === 'rejected') {
        const adapterIndex = results.indexOf(result);
        const adapterName = this.adapters[adapterIndex]?.name ?? 'unknown';
        const errorMsg =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push({ source: adapterName, error: errorMsg });
        this.log.warn('Adapter extraction failed', { source: adapterName, error: errorMsg });
      }
    }

    // Merge and deduplicate
    const mergedSummary = this.mergeSummaries(sourceResults);
    const decisions = this.mergeStringArrays(sourceResults.map((s) => s.decisions));
    const risks = this.mergeStringArrays(sourceResults.map((s) => s.risks));
    const actionItems = this.deduplicateActionItems(sourceResults.flatMap((s) => s.actionItems));

    const extraction: ExtractionResult = {
      meetingId,
      mergedSummary,
      decisions,
      risks,
      actionItems,
      sources: sourceResults,
      errors,
    };

    // Persist to database
    this.persistResults(extraction);

    this.log.info('Extraction completed', {
      meetingId,
      sourceCount: sourceResults.length,
      errorCount: errors.length,
      actionItemCount: actionItems.length,
    });

    return extraction;
  }

  /**
   * Fetch meeting notes from a single adapter and normalize into a SourceResult.
   */
  private async fetchFromAdapter(
    adapter: IMeetingAdapter,
    meetingId: string,
  ): Promise<SourceResult | null> {
    const available = await adapter.isAvailable();
    if (!available) {
      this.log.debug('Adapter not available, skipping', { source: adapter.name });
      return null;
    }

    const notes = await adapter.getMeetingNotes(meetingId);
    if (!notes) {
      this.log.debug('No meeting notes found', { source: adapter.name, meetingId });
      return null;
    }

    const decisions = this.extractDecisions(notes);
    const risks = this.extractRisks(notes);

    return {
      source: adapter.name,
      externalId: notes.meetingId,
      summary: notes.summary,
      decisions,
      risks,
      actionItems: notes.actionItems,
    };
  }

  /**
   * Extract decisions from meeting notes key points and metadata.
   */
  private extractDecisions(notes: MeetingNotes): string[] {
    const decisions: string[] = [];

    // Check metadata for explicit decisions
    const metaDecisions = notes.metadata?.decisions;
    if (Array.isArray(metaDecisions)) {
      decisions.push(...metaDecisions.map(String));
    }

    // Extract from key points prefixed with "Decision:"
    for (const point of notes.keyPoints) {
      if (point.startsWith('Decision: ')) {
        decisions.push(point.replace('Decision: ', ''));
      }
    }

    return [...new Set(decisions)];
  }

  /**
   * Extract risks from meeting notes key points and metadata.
   */
  private extractRisks(notes: MeetingNotes): string[] {
    const risks: string[] = [];

    const metaRisks = notes.metadata?.risks;
    if (Array.isArray(metaRisks)) {
      risks.push(...metaRisks.map(String));
    }

    for (const point of notes.keyPoints) {
      if (point.startsWith('Risk: ')) {
        risks.push(point.replace('Risk: ', ''));
      }
    }

    return [...new Set(risks)];
  }

  /**
   * Merge summaries from multiple sources into a consolidated summary.
   */
  private mergeSummaries(sources: SourceResult[]): string {
    if (sources.length === 0) return '';
    if (sources.length === 1) return sources[0].summary;

    return sources
      .filter((s) => s.summary)
      .map((s) => `[${s.source}] ${s.summary}`)
      .join('\n\n');
  }

  /**
   * Merge multiple string arrays, removing duplicates (case-insensitive).
   */
  private mergeStringArrays(arrays: string[][]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const arr of arrays) {
      for (const item of arr) {
        const normalized = item.toLowerCase().trim();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          result.push(item);
        }
      }
    }

    return result;
  }

  /**
   * Deduplicate action items by title similarity and owner match.
   * When duplicates are found, prefer the item with more detail.
   */
  private deduplicateActionItems(items: ActionItem[]): ActionItem[] {
    const unique: ActionItem[] = [];

    for (const item of items) {
      const duplicate = unique.find(
        (existing) =>
          this.isTitleSimilar(existing.title, item.title) &&
          this.isSameOwner(existing.assignee, item.assignee),
      );

      if (duplicate) {
        // Merge: prefer the more detailed version
        if ((item.description?.length ?? 0) > (duplicate.description?.length ?? 0)) {
          duplicate.description = item.description;
        }
        if (!duplicate.dueDate && item.dueDate) {
          duplicate.dueDate = item.dueDate;
        }
        if (duplicate.priority === 'none' && item.priority !== 'none') {
          duplicate.priority = item.priority;
        }
      } else {
        unique.push({ ...item });
      }
    }

    return unique;
  }

  /**
   * Check if two titles are similar enough to be considered duplicates.
   * Uses normalized comparison with a simple token overlap heuristic.
   */
  private isTitleSimilar(a: string, b: string): boolean {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim();

    const na = normalize(a);
    const nb = normalize(b);

    if (na === nb) return true;

    const tokensA = new Set(na.split(/\s+/));
    const tokensB = new Set(nb.split(/\s+/));
    const intersection = [...tokensA].filter((t) => tokensB.has(t));
    const union = new Set([...tokensA, ...tokensB]);

    // Jaccard similarity > 0.6
    return union.size > 0 && intersection.length / union.size > 0.6;
  }

  /**
   * Check if two owners refer to the same person (case-insensitive, trimmed).
   */
  private isSameOwner(a?: string, b?: string): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.toLowerCase().trim() === b.toLowerCase().trim();
  }

  /**
   * Generate a context hash for an action item to detect duplicates in the database.
   */
  private generateContextHash(item: ActionItem, meetingId: string): string {
    const key = `${meetingId}:${item.title.toLowerCase().trim()}:${(item.assignee ?? '').toLowerCase().trim()}`;
    return createHash('sha256').update(key).digest('hex');
  }

  /**
   * Initialize all adapters, ignoring failures (partial availability is acceptable).
   */
  private async initializeAdapters(): Promise<void> {
    const results = await Promise.allSettled(this.adapters.map((a) => a.initialize()));

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        this.log.warn('Adapter initialization failed', {
          source: this.adapters[i].name,
          error:
            (results[i] as PromiseRejectedResult).reason instanceof Error
              ? ((results[i] as PromiseRejectedResult).reason as Error).message
              : String((results[i] as PromiseRejectedResult).reason),
        });
      }
    }
  }

  /**
   * Persist extraction results to meeting_sources and action_items tables.
   */
  private persistResults(extraction: ExtractionResult): void {
    const db = getDb();

    const transaction = db.transaction(() => {
      // Store each source
      for (const source of extraction.sources) {
        queries.insertMeetingSource().run({
          id: randomUUID(),
          meetingId: extraction.meetingId,
          source: source.source,
          externalId: source.externalId,
          summary: source.summary,
          decisions: JSON.stringify(source.decisions),
          risks: JSON.stringify(source.risks),
          rawData: JSON.stringify(source),
        });
      }

      // Store deduplicated action items
      for (const item of extraction.actionItems) {
        const contextHash = this.generateContextHash(item, extraction.meetingId);

        // Skip if already exists (by context hash)
        const existing = queries.getActionItemByHash().get(contextHash);
        if (existing) continue;

        queries.insertActionItem().run({
          id: randomUUID(),
          meetingId: extraction.meetingId,
          source: item.source,
          title: item.title,
          description: item.description ?? null,
          owner: item.assignee ?? null,
          deadline: item.dueDate?.toISOString() ?? null,
          priority: item.priority ?? 'none',
          contextHash,
        });
      }

      // Update meeting with merged post-call notes
      queries.updateMeetingPostCall().run({
        id: extraction.meetingId,
        postCallNotes: JSON.stringify({
          summary: extraction.mergedSummary,
          decisions: extraction.decisions,
          risks: extraction.risks,
          actionItemCount: extraction.actionItems.length,
          sources: extraction.sources.map((s) => s.source),
          errors: extraction.errors,
        }),
      });
    });

    try {
      transaction();
      this.log.info('Extraction results persisted', { meetingId: extraction.meetingId });
    } catch (error) {
      this.log.error('Failed to persist extraction results', {
        meetingId: extraction.meetingId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
