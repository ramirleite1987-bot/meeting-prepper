/**
 * Sync Service for the Client Briefing Generator.
 * Orchestrates Linear adapter + reconciliation service for bidirectional sync.
 * Handles syncing action items to Linear and processing incoming webhook updates.
 */

import { randomUUID } from 'node:crypto';
import type { ActionItem, TaskReference, TaskStatus } from '../adapters/types.js';
import { LinearAdapter } from '../adapters/linear.adapter.js';
import { getDb, queries } from '../db/index.js';
import {
  ReconciliationService,
  buildReconciliationKey,
} from './reconciliation.service.js';
import { logger } from '../utils/logger.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface SyncResult {
  actionItemId: string;
  linearIssueId: string;
  status: 'created' | 'updated' | 'already-synced';
  taskReference: TaskReference;
}

export interface BatchSyncResult {
  meetingId: string;
  results: SyncResult[];
  errors: Array<{ actionItemId: string; error: string }>;
}

export interface WebhookUpdate {
  linearIssueId: string;
  status: TaskStatus;
  updatedAt: string;
}

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class SyncService {
  private linearAdapter: LinearAdapter;
  private reconciliationService: ReconciliationService;
  private initialized = false;

  constructor() {
    this.linearAdapter = new LinearAdapter();
    this.reconciliationService = new ReconciliationService();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.linearAdapter.initialize();
      await this.reconciliationService.initialize();
      this.initialized = true;
      logger.info('SyncService initialized');
    } catch (error) {
      logger.warn('SyncService initialization failed - sync features unavailable', { error });
    }
  }

  /**
   * Sync a single action item to Linear.
   * Creates a new issue or updates an existing one based on reconciliation.
   */
  async syncActionItem(meetingId: string, actionItemId: string): Promise<SyncResult> {
    await this.ensureInitialized();

    const db = getDb();
    const actionItem = db
      .prepare('SELECT * FROM action_items WHERE id = ? AND meeting_id = ?')
      .get(actionItemId, meetingId) as Record<string, unknown> | undefined;

    if (!actionItem) {
      throw new Error(`Action item ${actionItemId} not found in meeting ${meetingId}`);
    }

    const title = actionItem.title as string;

    // Check for existing task via reconciliation
    const key = buildReconciliationKey(meetingId, title, title);
    // Override contextHash if we have one stored
    if (actionItem.context_hash) {
      key.contextHash = actionItem.context_hash as string;
    }

    const existing = await this.reconciliationService.findExisting(key);

    if (existing) {
      // Update existing Linear issue
      const updates: Partial<ActionItem> = {
        title,
        description: actionItem.description as string | undefined,
        assignee: actionItem.owner as string | undefined,
        priority: actionItem.priority as ActionItem['priority'] | undefined,
      };
      if (actionItem.deadline) {
        updates.dueDate = new Date(actionItem.deadline as string);
      }

      const updated = await this.linearAdapter.updateTask(existing.id, updates);

      logger.info('Action item synced (updated)', {
        actionItemId,
        linearIssueId: existing.id,
      });

      return {
        actionItemId,
        linearIssueId: updated.id,
        status: 'updated',
        taskReference: updated,
      };
    }

    // Create new Linear issue
    const taskInput: ActionItem = {
      title,
      description: actionItem.description as string | undefined,
      assignee: actionItem.owner as string | undefined,
      priority: actionItem.priority as ActionItem['priority'] | undefined,
      status: (actionItem.status as ActionItem['status']) ?? 'pending',
      source: (actionItem.source as string) ?? 'meeting',
      meetingId,
    };

    if (actionItem.deadline) {
      taskInput.dueDate = new Date(actionItem.deadline as string);
    }

    const taskRef = await this.linearAdapter.createTask(taskInput);

    // Store cross-reference for future reconciliation
    this.reconciliationService.storeCrossReference(
      {
        meetingId,
        source: 'linear',
        linearIssueId: taskRef.id,
      },
      actionItemId,
    );

    logger.info('Action item synced (created)', {
      actionItemId,
      linearIssueId: taskRef.id,
    });

    return {
      actionItemId,
      linearIssueId: taskRef.id,
      status: 'created',
      taskReference: taskRef,
    };
  }

  /**
   * Sync all action items for a meeting to Linear.
   */
  async syncAllActionItems(meetingId: string): Promise<BatchSyncResult> {
    await this.ensureInitialized();

    const actionItems = queries.getActionItemsByMeeting().all(meetingId) as Array<
      Record<string, unknown>
    >;

    const results: SyncResult[] = [];
    const errors: Array<{ actionItemId: string; error: string }> = [];

    for (const item of actionItems) {
      const itemId = item.id as string;
      try {
        const result = await this.syncActionItem(meetingId, itemId);
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to sync action item', { actionItemId: itemId, error: message });
        errors.push({ actionItemId: itemId, error: message });
      }
    }

    logger.info('Batch sync completed', {
      meetingId,
      synced: results.length,
      failed: errors.length,
    });

    return { meetingId, results, errors };
  }

  /**
   * Process an incoming webhook status change from Linear.
   * Updates the local action_items status and adds a client_history event.
   */
  async handleLinearUpdate(update: WebhookUpdate): Promise<void> {
    const syncRecord = queries.getLinearSyncByIssue().get(update.linearIssueId) as
      | Record<string, unknown>
      | undefined;

    if (!syncRecord) {
      logger.debug('No sync record found for Linear issue', {
        linearIssueId: update.linearIssueId,
      });
      return;
    }

    const actionItemId = syncRecord.action_item_id as string | null;
    const meetingId = syncRecord.meeting_id as string;

    // Map TaskStatus to action_items status
    const actionItemStatus = this.mapTaskStatusToActionItem(update.status);

    if (actionItemId) {
      queries.updateActionItemStatus().run({
        id: actionItemId,
        status: actionItemStatus,
      });

      logger.info('Action item status updated from Linear webhook', {
        actionItemId,
        linearIssueId: update.linearIssueId,
        newStatus: actionItemStatus,
      });
    }

    // Update sync record timestamp
    queries.updateLinearSyncStatus().run({
      id: syncRecord.id as string,
      syncStatus: 'synced',
    });

    // Add client_history event
    const meeting = queries.getMeetingById().get(meetingId) as
      | Record<string, unknown>
      | undefined;

    if (meeting) {
      const clientId = meeting.client_id as string;
      queries.insertClientHistory().run({
        id: randomUUID(),
        clientId,
        meetingId,
        eventType: 'linear_status_change',
        eventData: JSON.stringify({
          linearIssueId: update.linearIssueId,
          actionItemId,
          newStatus: update.status,
          updatedAt: update.updatedAt,
        }),
      });
    }
  }

  // ──────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.initialized) {
      throw new Error('SyncService is not available. Check LINEAR_API_KEY configuration.');
    }
  }

  private mapTaskStatusToActionItem(
    status: TaskStatus,
  ): 'pending' | 'in-progress' | 'completed' | 'cancelled' {
    switch (status) {
      case 'backlog':
      case 'todo':
        return 'pending';
      case 'in-progress':
      case 'in-review':
        return 'in-progress';
      case 'done':
        return 'completed';
      case 'cancelled':
        return 'cancelled';
      default:
        return 'pending';
    }
  }
}
