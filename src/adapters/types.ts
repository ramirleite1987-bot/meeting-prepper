/**
 * Adapter type definitions for the Client Briefing Generator.
 * Defines common interfaces and shared types used across all data source adapters.
 */

// ──────────────────────────────────────────────
// Shared Types
// ──────────────────────────────────────────────

export interface ContextEntry {
  source: string;
  type: 'note' | 'message' | 'commit' | 'event' | 'task' | 'other';
  title: string;
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ActionItem {
  id?: string;
  title: string;
  description?: string;
  assignee?: string;
  dueDate?: Date;
  priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  status: 'pending' | 'in-progress' | 'completed' | 'cancelled';
  source: string;
  meetingId?: string;
  linearIssueId?: string;
  metadata?: Record<string, unknown>;
}

export interface MeetingNotes {
  meetingId: string;
  title: string;
  date: Date;
  attendees: string[];
  summary: string;
  keyPoints: string[];
  actionItems: ActionItem[];
  rawTranscript?: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface MeetingSummary {
  meetingId: string;
  title: string;
  date: Date;
  attendees: string[];
  source: string;
  durationMinutes?: number;
}

export interface TaskReference {
  id: string;
  externalId: string;
  source: string;
  url?: string;
  title: string;
  status: TaskStatus;
  meetingId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TaskStatus = 'backlog' | 'todo' | 'in-progress' | 'in-review' | 'done' | 'cancelled';

// ──────────────────────────────────────────────
// Adapter Interfaces
// ──────────────────────────────────────────────

/**
 * Base interface for all data source adapters.
 * Provides lifecycle management and availability checks.
 */
export interface IDataSourceAdapter {
  readonly name: string;

  /** Initialize the adapter (connect, authenticate, etc.) */
  initialize(): Promise<void>;

  /** Check if the adapter's data source is currently available */
  isAvailable(): Promise<boolean>;

  /** Disconnect and clean up resources */
  disconnect(): Promise<void>;
}

/**
 * Adapter for retrieving client context from various sources
 * (Obsidian, Calendar, Telegram, Git).
 */
export interface IContextAdapter extends IDataSourceAdapter {
  /** Retrieve context entries for a given client */
  getClientContext(
    clientName: string,
    options?: { since?: Date; limit?: number },
  ): Promise<ContextEntry[]>;
}

/**
 * Adapter for consuming meeting notes and transcripts
 * (Krisp MCP, Granola MCP).
 */
export interface IMeetingAdapter extends IDataSourceAdapter {
  /** Get full meeting notes including transcript and action items */
  getMeetingNotes(meetingId: string): Promise<MeetingNotes | null>;

  /** Get action items extracted from a meeting */
  getActionItems(meetingId: string): Promise<ActionItem[]>;

  /** Search for meetings matching the given query */
  searchMeetings(
    query: string,
    options?: { since?: Date; limit?: number },
  ): Promise<MeetingSummary[]>;
}

/**
 * Adapter for creating and managing tasks in external project management tools
 * (Linear).
 */
export interface ITaskAdapter extends IDataSourceAdapter {
  /** Create a new task from an action item */
  createTask(actionItem: ActionItem): Promise<TaskReference>;

  /** Update an existing task */
  updateTask(taskId: string, updates: Partial<ActionItem>): Promise<TaskReference>;

  /** Get the current status of a task */
  getTaskStatus(taskId: string): Promise<TaskStatus>;
}
