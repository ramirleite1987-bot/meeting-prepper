/**
 * Reconciliation Service for the Client Briefing Generator.
 * Provides idempotent task matching using ReconciliationKey (meeting_id + title + context_hash).
 * Lookup order: (1) local linear_sync table, (2) Linear API filter.
 * Stores cross-references on every create for future lookups.
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { LinearClient } from '@linear/sdk';
import type { TaskReference, TaskStatus } from '../adapters/types.js';
import { getDb, queries } from '../db/index.js';
import { logger } from '../utils/logger.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface ReconciliationKey {
  meetingId: string;
  title: string;
  contextHash: string;
}

export interface CrossReference {
  meetingId: string;
  source: string;
  linearIssueId: string;
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Build a SHA-256 context hash from arbitrary context string */
export function buildContextHash(context: string): string {
  return createHash('sha256').update(context).digest('hex');
}

/** Build a ReconciliationKey from meeting ID, title, and context */
export function buildReconciliationKey(
  meetingId: string,
  title: string,
  context: string,
): ReconciliationKey {
  return {
    meetingId,
    title,
    contextHash: buildContextHash(context),
  };
}

/** Map Linear workflow state names to internal TaskStatus */
function mapLinearState(stateName: string): TaskStatus {
  const lower = stateName.toLowerCase();
  if (lower.includes('backlog')) return 'backlog';
  if (lower.includes('todo') || lower.includes('to do')) return 'todo';
  if (lower.includes('in progress') || lower.includes('started')) return 'in-progress';
  if (lower.includes('review') || lower.includes('in review')) return 'in-review';
  if (lower.includes('done') || lower.includes('completed')) return 'done';
  if (lower.includes('cancel')) return 'cancelled';
  return 'todo';
}

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class ReconciliationService {
  private client: LinearClient | null = null;

  async initialize(): Promise<void> {
    const apiKey = process.env.LINEAR_API_KEY;
    if (apiKey) {
      this.client = new LinearClient({ apiKey });
    }
    logger.info('ReconciliationService initialized', {
      linearAvailable: !!this.client,
    });
  }

  /**
   * Find an existing task by reconciliation key.
   * Lookup order: (1) local linear_sync table, (2) Linear API filter.
   * Returns existing TaskReference or null if no match found.
   */
  async findExisting(key: ReconciliationKey): Promise<TaskReference | null> {
    // Step 1: Check local linear_sync table
    const localMatch = this.findInLocalDb(key);
    if (localMatch) {
      logger.debug('Reconciliation: found local match', {
        meetingId: key.meetingId,
        linearIssueId: localMatch.linearIssueId,
      });
      return this.resolveTaskReference(localMatch);
    }

    // Step 2: Query Linear API with filter
    if (this.client) {
      const remoteMatch = await this.findInLinear(key);
      if (remoteMatch) {
        logger.debug('Reconciliation: found remote match', {
          meetingId: key.meetingId,
          issueId: remoteMatch.id,
        });
        return remoteMatch;
      }
    }

    return null;
  }

  /**
   * Store a cross-reference between a meeting, source, and Linear issue.
   * Called on every task create to enable future reconciliation.
   */
  storeCrossReference(ref: CrossReference, actionItemId?: string): void {
    const id = randomUUID();

    try {
      queries.insertLinearSync().run({
        id,
        actionItemId: actionItemId ?? null,
        meetingId: ref.meetingId,
        linearIssueId: ref.linearIssueId,
        source: ref.source,
        syncStatus: 'synced',
      });

      logger.info('Stored cross-reference', {
        meetingId: ref.meetingId,
        linearIssueId: ref.linearIssueId,
        source: ref.source,
      });
    } catch (error) {
      // Handle unique constraint violations gracefully (idempotent)
      if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
        logger.debug('Cross-reference already exists', {
          meetingId: ref.meetingId,
          linearIssueId: ref.linearIssueId,
        });
        return;
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────

  private findInLocalDb(
    key: ReconciliationKey,
  ): { linearIssueId: string; meetingId: string; source: string } | null {
    const db = getDb();

    // Check linear_sync for matching meeting_id, then verify title/hash via action_items
    const rows = queries.getLinearSyncByMeeting().all(key.meetingId) as Array<{
      linear_issue_id: string;
      meeting_id: string;
      source: string;
      action_item_id: string | null;
    }>;

    for (const row of rows) {
      if (row.action_item_id) {
        const actionItem = db
          .prepare('SELECT title, context_hash FROM action_items WHERE id = ?')
          .get(row.action_item_id) as { title: string; context_hash: string } | undefined;

        if (
          actionItem &&
          actionItem.title === key.title &&
          actionItem.context_hash === key.contextHash
        ) {
          return {
            linearIssueId: row.linear_issue_id,
            meetingId: row.meeting_id,
            source: row.source,
          };
        }
      }
    }

    return null;
  }

  private async findInLinear(key: ReconciliationKey): Promise<TaskReference | null> {
    if (!this.client) return null;

    try {
      const issues = await this.client.issues({
        filter: {
          title: { contains: key.title },
        },
        first: 5,
      });

      for (const issue of issues.nodes) {
        // Check if description contains the meeting ID or context hash
        const description = issue.description ?? '';
        if (description.includes(key.meetingId) || description.includes(key.contextHash)) {
          const state = await issue.state;
          return {
            id: issue.id,
            externalId: issue.identifier,
            source: 'linear',
            url: issue.url,
            title: issue.title,
            status: state ? mapLinearState(state.name) : 'todo',
            meetingId: key.meetingId,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
          };
        }
      }

      return null;
    } catch (error) {
      logger.warn('Failed to query Linear API for reconciliation', { error });
      return null;
    }
  }

  private async resolveTaskReference(match: {
    linearIssueId: string;
    meetingId: string;
    source: string;
  }): Promise<TaskReference | null> {
    if (!this.client) {
      // Return minimal reference without API data
      return {
        id: match.linearIssueId,
        externalId: match.linearIssueId,
        source: match.source,
        title: '',
        status: 'todo',
        meetingId: match.meetingId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    try {
      const issue = await this.client.issue(match.linearIssueId);
      const state = await issue.state;

      return {
        id: issue.id,
        externalId: issue.identifier,
        source: 'linear',
        url: issue.url,
        title: issue.title,
        status: state ? mapLinearState(state.name) : 'todo',
        meetingId: match.meetingId,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      };
    } catch (error) {
      logger.warn('Failed to resolve task reference from Linear', {
        linearIssueId: match.linearIssueId,
        error,
      });
      return null;
    }
  }
}
