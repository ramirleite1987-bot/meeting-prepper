/**
 * Linear adapter for the Client Briefing Generator.
 * Implements ITaskAdapter for creating and managing Linear issues
 * with bidirectional sync support.
 */

import { LinearClient } from '@linear/sdk';
import type { ITaskAdapter, ActionItem, TaskReference, TaskStatus } from './types.js';
import { TokenBucket, withRateLimitedRetry } from './linear-rate-limiter.js';
import { mapLinearStateToTaskStatus, mapPriorityToLinear } from './linear-status.js';

export class LinearAdapter implements ITaskAdapter {
  readonly name = 'linear';

  private client: LinearClient | null = null;
  private teamId: string | null = null;
  private readonly rateLimiter = new TokenBucket();

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

  async updateTask(taskId: string, updates: Partial<ActionItem>): Promise<TaskReference> {
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

  private ensureClient(): void {
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
    return state ? mapLinearStateToTaskStatus(state.name) : 'todo';
  }

  /**
   * Run an operation against Linear with local pre-throttle and
   * Retry-After-aware retry on 429s. See `linear-rate-limiter.ts`
   * for the underlying implementation.
   */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    return withRateLimitedRetry(fn, { maxRetries, bucket: this.rateLimiter });
  }
}
