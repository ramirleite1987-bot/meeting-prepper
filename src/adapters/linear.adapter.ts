/**
 * Linear adapter for the Client Briefing Generator.
 * Implements ITaskAdapter for creating and managing Linear issues
 * with bidirectional sync support.
 */

import { LinearClient } from '@linear/sdk';
import type {
  ITaskAdapter,
  ActionItem,
  TaskReference,
  TaskStatus,
} from './types.js';

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

/** Map internal priority to Linear priority number (0=none, 1=urgent, 2=high, 3=medium, 4=low) */
function mapPriorityToLinear(priority?: ActionItem['priority']): number {
  switch (priority) {
    case 'urgent': return 1;
    case 'high': return 2;
    case 'medium': return 3;
    case 'low': return 4;
    case 'none':
    default: return 0;
  }
}

export class LinearAdapter implements ITaskAdapter {
  readonly name = 'linear';

  private client: LinearClient | null = null;
  private teamId: string | null = null;

  async initialize(): Promise<void> {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      throw new Error('LINEAR_API_KEY environment variable is required');
    }

    this.client = new LinearClient({ apiKey });

    // Cache the default team ID
    const teamId = process.env.LINEAR_TEAM_ID;
    if (teamId) {
      this.teamId = teamId;
    } else {
      const teams = await this.withRetry(() => this.client!.teams());
      if (teams.nodes.length > 0) {
        this.teamId = teams.nodes[0].id;
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.withRetry(() => this.client!.viewer);
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.teamId = null;
  }

  async createTask(actionItem: ActionItem): Promise<TaskReference> {
    this.ensureClient();

    const teamId = await this.resolveTeamId();
    const assigneeId = actionItem.assignee
      ? await this.lookupAssignee(actionItem.assignee)
      : undefined;

    const result = await this.withRetry(() =>
      this.client!.createIssue({
        teamId,
        title: actionItem.title,
        description: actionItem.description,
        assigneeId,
        dueDate: actionItem.dueDate?.toISOString().split('T')[0],
        priority: mapPriorityToLinear(actionItem.priority),
      }),
    );

    const issue = await result.issue;
    if (!issue) {
      throw new Error('Failed to create Linear issue');
    }

    return {
      id: issue.id,
      externalId: issue.identifier,
      source: 'linear',
      url: issue.url,
      title: issue.title,
      status: await this.getIssueStatus(issue.id),
      meetingId: actionItem.meetingId,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
  }

  async updateTask(
    taskId: string,
    updates: Partial<ActionItem>,
  ): Promise<TaskReference> {
    this.ensureClient();

    const input: Record<string, unknown> = {};
    if (updates.title !== undefined) input.title = updates.title;
    if (updates.description !== undefined) input.description = updates.description;
    if (updates.dueDate !== undefined) {
      input.dueDate = updates.dueDate.toISOString().split('T')[0];
    }
    if (updates.priority !== undefined) {
      input.priority = mapPriorityToLinear(updates.priority);
    }
    if (updates.assignee !== undefined) {
      input.assigneeId = await this.lookupAssignee(updates.assignee);
    }

    await this.withRetry(() => this.client!.updateIssue(taskId, input));

    const issue = await this.withRetry(() => this.client!.issue(taskId));

    return {
      id: issue.id,
      externalId: issue.identifier,
      source: 'linear',
      url: issue.url,
      title: issue.title,
      status: await this.getIssueStatus(issue.id),
      meetingId: updates.meetingId,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    this.ensureClient();
    return this.getIssueStatus(taskId);
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  private ensureClient(): asserts this is this & { client: LinearClient } {
    if (!this.client) {
      throw new Error('LinearAdapter not initialized. Call initialize() first.');
    }
  }

  private async resolveTeamId(): Promise<string> {
    if (this.teamId) return this.teamId;
    const teams = await this.withRetry(() => this.client!.teams());
    if (teams.nodes.length === 0) {
      throw new Error('No Linear teams found');
    }
    this.teamId = teams.nodes[0].id;
    return this.teamId;
  }

  private async lookupAssignee(nameOrEmail: string): Promise<string | undefined> {
    try {
      const users = await this.withRetry(() =>
        this.client!.users({ filter: { displayName: { contains: nameOrEmail } } }),
      );
      if (users.nodes.length > 0) {
        return users.nodes[0].id;
      }
      // Try email match
      const byEmail = await this.withRetry(() =>
        this.client!.users({ filter: { email: { contains: nameOrEmail } } }),
      );
      if (byEmail.nodes.length > 0) {
        return byEmail.nodes[0].id;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async getIssueStatus(issueId: string): Promise<TaskStatus> {
    const issue = await this.withRetry(() => this.client!.issue(issueId));
    const state = await issue.state;
    return state ? mapLinearState(state.name) : 'todo';
  }

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error;
        const isRateLimit =
          error instanceof Error && error.message.includes('rate limit');
        if (!isRateLimit || attempt === maxRetries - 1) {
          throw error;
        }
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }
}
