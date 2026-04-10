/**
 * Krisp MCP adapter for the Client Briefing Generator.
 * Uses the MCP client to interact with the Krisp meeting notes service.
 * Chains: search_meetings → extract document ID → get_document → list_action_items.
 */

import { Client } from '@modelcontextprotocol/client';
import { createMCPClient } from '../utils/mcp-client.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type {
  IMeetingAdapter,
  MeetingNotes,
  MeetingSummary,
  ActionItem,
} from './types.js';

const log = logger.child('KrispAdapter');

/** Regex to extract a 32-character hex document ID from Krisp responses */
const DOCUMENT_ID_REGEX = /\b([a-f0-9]{32})\b/i;

interface KrispMeetingResult {
  id?: string;
  title?: string;
  date?: string;
  attendees?: string[];
  duration_minutes?: number;
  document_id?: string;
  [key: string]: unknown;
}

interface KrispDocumentResult {
  id?: string;
  title?: string;
  date?: string;
  attendees?: string[];
  summary?: string;
  transcript?: string;
  key_points?: string[];
  decisions?: string[];
  risks?: string[];
  [key: string]: unknown;
}

interface KrispActionItemResult {
  id?: string;
  title?: string;
  description?: string;
  assignee?: string;
  due_date?: string;
  priority?: string;
  status?: string;
  [key: string]: unknown;
}

export class KrispAdapter implements IMeetingAdapter {
  readonly name = 'krisp';
  private client: Client | null = null;
  private serverUrl: string | undefined;

  constructor(serverUrl?: string) {
    this.serverUrl = serverUrl ?? config.krispMcpServerUrl;
  }

  async initialize(): Promise<void> {
    if (!this.serverUrl) {
      log.warn('Krisp MCP server URL not configured');
      return;
    }

    this.client = await createMCPClient({
      serverUrl: this.serverUrl,
      service: 'krisp',
    });
  }

  async isAvailable(): Promise<boolean> {
    return this.client !== null;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      log.info('Krisp MCP client disconnected');
    }
  }

  async searchMeetings(
    query: string,
    options?: { since?: Date; limit?: number },
  ): Promise<MeetingSummary[]> {
    const results = await this.callTool<KrispMeetingResult[]>(
      'search_meetings',
      {
        query,
        ...(options?.since && { since: options.since.toISOString() }),
        ...(options?.limit && { limit: options.limit }),
      },
    );

    if (!results || !Array.isArray(results)) {
      return [];
    }

    return results.map((m) => ({
      meetingId: m.id ?? '',
      title: m.title ?? 'Untitled Meeting',
      date: m.date ? new Date(m.date) : new Date(),
      attendees: m.attendees ?? [],
      source: 'krisp',
      durationMinutes: m.duration_minutes,
    }));
  }

  async getMeetingNotes(meetingId: string): Promise<MeetingNotes | null> {
    // Step 1: Get document by searching for the meeting
    const searchResults = await this.callTool<KrispMeetingResult[]>(
      'search_meetings',
      { query: meetingId },
    );

    const documentId = this.extractDocumentId(meetingId, searchResults);
    if (!documentId) {
      log.warn('Could not extract document ID', { meetingId });
      return null;
    }

    // Step 2: Get the full document
    const doc = await this.callTool<KrispDocumentResult>(
      'get_document',
      { id: documentId },
    );

    if (!doc) {
      log.warn('Document not found', { documentId, meetingId });
      return null;
    }

    // Step 3: Get action items
    const actionItems = await this.getActionItems(meetingId);

    // Build key points from decisions and risks
    const keyPoints: string[] = [
      ...(doc.key_points ?? []),
      ...(doc.decisions ?? []).map((d) => `Decision: ${d}`),
      ...(doc.risks ?? []).map((r) => `Risk: ${r}`),
    ];

    return {
      meetingId,
      title: doc.title ?? 'Untitled Meeting',
      date: doc.date ? new Date(doc.date) : new Date(),
      attendees: doc.attendees ?? [],
      summary: doc.summary ?? '',
      keyPoints,
      actionItems,
      rawTranscript: doc.transcript,
      source: 'krisp',
      metadata: {
        documentId,
        decisions: doc.decisions,
        risks: doc.risks,
      },
    };
  }

  async getActionItems(meetingId: string): Promise<ActionItem[]> {
    const results = await this.callTool<KrispActionItemResult[]>(
      'list_action_items',
      { meetingId },
    );

    if (!results || !Array.isArray(results)) {
      return [];
    }

    return results.map((item) => ({
      id: item.id,
      title: item.title ?? '',
      description: item.description,
      assignee: item.assignee,
      dueDate: item.due_date ? new Date(item.due_date) : undefined,
      priority: this.mapPriority(item.priority),
      status: this.mapStatus(item.status),
      source: 'krisp',
      meetingId,
    }));
  }

  /**
   * Extract a 32-character document ID from the meeting ID itself or search results.
   */
  private extractDocumentId(
    meetingId: string,
    searchResults?: KrispMeetingResult[] | null,
  ): string | null {
    // Check if meetingId itself is a 32-char hex string
    const directMatch = meetingId.match(DOCUMENT_ID_REGEX);
    if (directMatch) {
      return directMatch[1];
    }

    // Look for document_id in search results
    if (searchResults && Array.isArray(searchResults)) {
      for (const result of searchResults) {
        if (result.document_id) {
          return result.document_id;
        }
        if (result.id) {
          const idMatch = result.id.match(DOCUMENT_ID_REGEX);
          if (idMatch) return idMatch[1];
        }
      }

      // Try to find in stringified results
      const raw = JSON.stringify(searchResults);
      const rawMatch = raw.match(DOCUMENT_ID_REGEX);
      if (rawMatch) {
        return rawMatch[1];
      }
    }

    return null;
  }

  /**
   * Call an MCP tool with automatic 401 retry via token refresh.
   */
  private async callTool<T>(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.client) {
      log.error('Krisp MCP client not initialized');
      return null;
    }

    try {
      return await this.executeToolCall<T>(toolName, args);
    } catch (error: unknown) {
      if (this.isTokenExpiredError(error)) {
        log.info('Token expired, reconnecting', { toolName });
        try {
          await this.reconnect();
          return await this.executeToolCall<T>(toolName, args);
        } catch (retryError) {
          log.error('Retry after token refresh failed', {
            toolName,
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
          return null;
        }
      }

      log.error('MCP tool call failed', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async executeToolCall<T>(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.client!.callTool({ name: toolName, arguments: args });

    if (!result.content || !Array.isArray(result.content) || result.content.length === 0) {
      return null;
    }

    const textContent = result.content.find(
      (c: { type: string }) => c.type === 'text',
    ) as { type: 'text'; text: string } | undefined;

    if (!textContent) {
      return null;
    }

    try {
      return JSON.parse(textContent.text) as T;
    } catch {
      log.warn('Failed to parse MCP response as JSON', { toolName });
      return textContent.text as unknown as T;
    }
  }

  private isTokenExpiredError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return msg.includes('401') || msg.includes('unauthorized') || msg.includes('token expired');
    }
    return false;
  }

  private async reconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors during reconnect
      }
    }

    this.client = await createMCPClient({
      serverUrl: this.serverUrl!,
      service: 'krisp',
    });
  }

  private mapPriority(
    priority?: string,
  ): 'urgent' | 'high' | 'medium' | 'low' | 'none' {
    if (!priority) return 'none';
    const normalized = priority.toLowerCase();
    if (normalized === 'urgent' || normalized === 'critical') return 'urgent';
    if (normalized === 'high') return 'high';
    if (normalized === 'medium' || normalized === 'normal') return 'medium';
    if (normalized === 'low') return 'low';
    return 'none';
  }

  private mapStatus(
    status?: string,
  ): 'pending' | 'in-progress' | 'completed' | 'cancelled' {
    if (!status) return 'pending';
    const normalized = status.toLowerCase();
    if (normalized === 'completed' || normalized === 'done') return 'completed';
    if (normalized === 'in-progress' || normalized === 'in_progress') return 'in-progress';
    if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
    return 'pending';
  }
}
