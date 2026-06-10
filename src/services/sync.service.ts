/**
 * Sync Service for the Client Briefing Generator.
 * Orchestrates Linear adapter + reconciliation service for bidirectional sync.
 * Handles syncing action items to Linear and processing incoming webhook updates.
 */

import { randomUUID } from 'node:crypto';
import type { ActionItem, TaskReference, TaskStatus } from '../adapters/types.js';
import { LinearAdapter } from '../adapters/linear.adapter.js';
import { getDb, queries } from '../db/index.js';
import { ReconciliationService, buildReconciliationKey } from './reconciliation.service.js';
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

export interface ReconcileResult {
  checked: number;
  updated: number;
  errors: Array<{ linearIssueId: string; error: string }>;
}

export interface LinearSyncOptions {
  projectId?: string;
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
  async syncActionItem(
    meetingId: string,
    actionItemId: string,
    options: LinearSyncOptions = {},
  ): Promise<SyncResult> {
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
      metadata: options.projectId ? { linearProjectId: options.projectId } : undefined,
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
  async syncAllActionItems(
    meetingId: string,
    options: LinearSyncOptions = {},
  ): Promise<BatchSyncResult> {
    await this.ensureInitialized();

    const actionItems = queries.getActionItemsByMeeting().all(meetingId) as Array<
      Record<string, unknown>
    >;

    const results: SyncResult[] = [];
    const errors: Array<{ actionItemId: string; error: string }> = [];

    for (const item of actionItems) {
      const itemId = item.id as string;
      try {
        const result = await this.syncActionItem(meetingId, itemId, options);
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
    const meeting = queries.getMeetingById().get(meetingId) as Record<string, unknown> | undefined;

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

  /**
   * Pull current issue status from Linear for synced action items and update
   * local state on change. This is the polling counterpart to the webhook
   * path (`handleLinearUpdate`) — it catches updates the webhook never
   * delivered (missed events, issues closed while the app was down).
   */
  async reconcileFromLinear(meetingId?: string): Promise<ReconcileResult> {
    await this.ensureInitialized();

    const rows = (
      meetingId ? queries.getLinearSyncByMeeting().all(meetingId) : queries.getAllLinearSync().all()
    ) as Array<Record<string, unknown>>;

    const result: ReconcileResult = { checked: 0, updated: 0, errors: [] };

    for (const row of rows) {
      const linearIssueId = row.linear_issue_id as string;
      result.checked++;

      try {
        const status = await this.linearAdapter.getTaskStatus(linearIssueId);
        const changed = this.applyReconciledStatus(row, status);
        if (changed) result.updated++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ linearIssueId, error: message });
        logger.warn('Linear reconciliation failed for issue', { linearIssueId, error: message });
      }
    }

    logger.info('Linear reconciliation completed', {
      meetingId: meetingId ?? 'all',
      ...result,
      errors: result.errors.length,
    });

    return result;
  }

  /**
   * Update the local action item if Linear's status diverges.
   * Returns true when a change was applied.
   */
  private applyReconciledStatus(syncRow: Record<string, unknown>, status: TaskStatus): boolean {
    const actionItemId = syncRow.action_item_id as string | null;
    const newStatus = this.mapTaskStatusToActionItem(status);

    queries.updateLinearSyncStatus().run({
      id: syncRow.id as string,
      syncStatus: 'synced',
    });

    if (!actionItemId) return false;

    const actionItem = queries.getActionItemById().get(actionItemId) as
      | Record<string, unknown>
      | undefined;
    if (!actionItem || actionItem.status === newStatus) return false;

    queries.updateActionItemStatus().run({ id: actionItemId, status: newStatus });

    const meetingId = syncRow.meeting_id as string;
    const meeting = queries.getMeetingById().get(meetingId) as Record<string, unknown> | undefined;
    if (meeting) {
      queries.insertClientHistory().run({
        id: randomUUID(),
        clientId: meeting.client_id as string,
        meetingId,
        eventType: 'linear_status_change',
        eventData: JSON.stringify({
          linearIssueId: syncRow.linear_issue_id,
          actionItemId,
          previousStatus: actionItem.status,
          newStatus: status,
          via: 'reconciliation',
        }),
      });
    }

    logger.info('Action item status reconciled from Linear', {
      actionItemId,
      linearIssueId: syncRow.linear_issue_id,
      previousStatus: actionItem.status,
      newStatus,
    });

    return true;
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
