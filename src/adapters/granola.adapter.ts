/**
 * Granola adapter for the Client Briefing Generator.
 * Uses the MCP client to interact with the Granola meeting notes service.
 * Chains: list_meetings → get_meetings(id) → optionally get_meeting_transcript.
 * Falls back to Granola REST API (public-api.granola.ai) when GRANOLA_API_KEY is set.
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

const log = logger.child('GranolaAdapter');

const GRANOLA_REST_BASE_URL = 'https://public-api.granola.ai';

interface GranolaMeetingResult {
  id?: string;
  title?: string;
  date?: string;
  attendees?: string[];
  duration_minutes?: number;
  summary?: string;
  [key: string]: unknown;
}

interface GranolaMeetingDetail {
  id?: string;
  title?: string;
  date?: string;
  attendees?: string[];
  summary?: string;
  notes?: string;
  key_points?: string[];
  transcript?: string;
  action_items?: GranolaActionItemResult[];
  [key: string]: unknown;
}

interface GranolaActionItemResult {
  id?: string;
  title?: string;
  description?: string;
  assignee?: string;
  due_date?: string;
  priority?: string;
  status?: string;
  [key: string]: unknown;
}

export class GranolaAdapter implements IMeetingAdapter {
  readonly name = 'granola';
  private client: Client | null = null;
  private serverUrl: string | undefined;
  private apiKey: string | undefined;

  constructor(serverUrl?: string, apiKey?: string) {
    this.serverUrl = serverUrl ?? config.granolaMcpServerUrl;
    this.apiKey = apiKey ?? process.env.GRANOLA_API_KEY;
  }

  async initialize(): Promise<void> {
    if (!this.serverUrl && !this.apiKey) {
      log.warn('Granola MCP server URL and API key not configured');
      return;
    }

    if (this.serverUrl) {
      try {
        this.client = await createMCPClient({
          serverUrl: this.serverUrl,
          service: 'granola',
        });
      } catch (error) {
        log.warn('Failed to connect to Granola MCP, will use REST fallback if API key is set', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.client !== null || !!this.apiKey;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      log.info('Granola MCP client disconnected');
    }
  }

  async searchMeetings(
    query: string,
    options?: { since?: Date; limit?: number },
  ): Promise<MeetingSummary[]> {
    if (this.client) {
      return this.searchMeetingsMcp(query, options);
    }
    if (this.apiKey) {
      return this.searchMeetingsRest(query, options);
    }
    return [];
  }

  async getMeetingNotes(meetingId: string): Promise<MeetingNotes | null> {
    if (this.client) {
      return this.getMeetingNotesMcp(meetingId);
    }
    if (this.apiKey) {
      return this.getMeetingNotesRest(meetingId);
    }
    return null;
  }

  async getActionItems(meetingId: string): Promise<ActionItem[]> {
    const notes = await this.getMeetingNotes(meetingId);
    return notes?.actionItems ?? [];
  }

  // ──────────────────────────────────────────────
  // MCP methods
  // ──────────────────────────────────────────────

  private async searchMeetingsMcp(
    query: string,
    options?: { since?: Date; limit?: number },
  ): Promise<MeetingSummary[]> {
    const results = await this.callTool<GranolaMeetingResult[]>(
      'list_meetings',
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
      source: 'granola',
      durationMinutes: m.duration_minutes,
    }));
  }

  private async getMeetingNotesMcp(meetingId: string): Promise<MeetingNotes | null> {
    const detail = await this.callTool<GranolaMeetingDetail>(
      'get_meetings',
      { id: meetingId },
    );

    if (!detail) {
      log.warn('Meeting not found via MCP', { meetingId });
      return null;
    }

    // Optionally fetch transcript (paid plan feature)
    let transcript = detail.transcript;
    if (!transcript) {
      const transcriptResult = await this.callTool<{ transcript?: string }>(
        'get_meeting_transcript',
        { id: meetingId },
      );
      transcript = transcriptResult?.transcript;
    }

    const actionItems = this.mapActionItems(detail.action_items, meetingId);

    return {
      meetingId,
      title: detail.title ?? 'Untitled Meeting',
      date: detail.date ? new Date(detail.date) : new Date(),
      attendees: detail.attendees ?? [],
      summary: detail.summary ?? detail.notes ?? '',
      keyPoints: detail.key_points ?? [],
      actionItems,
      rawTranscript: transcript,
      source: 'granola',
    };
  }

  // ──────────────────────────────────────────────
  // REST API fallback methods
  // ──────────────────────────────────────────────

  private async searchMeetingsRest(
    query: string,
    options?: { since?: Date; limit?: number },
  ): Promise<MeetingSummary[]> {
    const params = new URLSearchParams({ q: query });
    if (options?.since) params.set('since', options.since.toISOString());
    if (options?.limit) params.set('limit', String(options.limit));

    const data = await this.restGet<GranolaMeetingResult[]>(
      `/v1/meetings?${params.toString()}`,
    );

    if (!data || !Array.isArray(data)) {
      return [];
    }

    return data.map((m) => ({
      meetingId: m.id ?? '',
      title: m.title ?? 'Untitled Meeting',
      date: m.date ? new Date(m.date) : new Date(),
      attendees: m.attendees ?? [],
      source: 'granola',
      durationMinutes: m.duration_minutes,
    }));
  }

  private async getMeetingNotesRest(meetingId: string): Promise<MeetingNotes | null> {
    const detail = await this.restGet<GranolaMeetingDetail>(
      `/v1/meetings/${encodeURIComponent(meetingId)}`,
    );

    if (!detail) {
      log.warn('Meeting not found via REST', { meetingId });
      return null;
    }

    const actionItems = this.mapActionItems(detail.action_items, meetingId);

    return {
      meetingId,
      title: detail.title ?? 'Untitled Meeting',
      date: detail.date ? new Date(detail.date) : new Date(),
      attendees: detail.attendees ?? [],
      summary: detail.summary ?? detail.notes ?? '',
      keyPoints: detail.key_points ?? [],
      actionItems,
      rawTranscript: detail.transcript,
      source: 'granola',
    };
  }

  private async restGet<T>(path: string): Promise<T | null> {
    try {
      const response = await fetch(`${GRANOLA_REST_BASE_URL}${path}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        log.error('Granola REST API error', {
          status: response.status,
          path,
        });
        return null;
      }

      return (await response.json()) as T;
    } catch (error) {
      log.error('Granola REST API request failed', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // Shared helpers
  // ──────────────────────────────────────────────

  private mapActionItems(
    items?: GranolaActionItemResult[],
    meetingId?: string,
  ): ActionItem[] {
    if (!items || !Array.isArray(items)) {
      return [];
    }

    return items.map((item) => ({
      id: item.id,
      title: item.title ?? '',
      description: item.description,
      assignee: item.assignee,
      dueDate: item.due_date ? new Date(item.due_date) : undefined,
      priority: this.mapPriority(item.priority),
      status: this.mapStatus(item.status),
      source: 'granola',
      meetingId,
    }));
  }

  /**
   * Call an MCP tool with automatic 401 retry via token refresh.
   */
  private async callTool<T>(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.client) {
      log.error('Granola MCP client not initialized');
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
      service: 'granola',
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
