/**
 * Granola adapter for the Client Briefing Generator.
 * Uses the MCP client to interact with the Granola meeting notes service.
 * Chains: list_meetings → get_meetings(id) → optionally get_meeting_transcript.
 * Falls back to Granola REST API (public-api.granola.ai) when GRANOLA_API_KEY is set.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMCPClient } from '../utils/mcp-client.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withTimeout } from '../utils/async-timeout.js';
import type { IMeetingAdapter, MeetingNotes, MeetingSummary, ActionItem } from './types.js';
import {
  firstString,
  normalizeActionItems,
  normalizeMeetingNotes,
  normalizeMeetingSummary,
  normalizeString,
  normalizeTextArray,
} from './meeting-normalizer.js';

const log = logger.child('GranolaAdapter');

const GRANOLA_REST_BASE_URL = 'https://public-api.granola.ai';

interface GranolaMeetingResult {
  id?: unknown;
  title?: unknown;
  date?: unknown;
  attendees?: unknown;
  duration_minutes?: unknown;
  summary?: unknown;
  [key: string]: unknown;
}

interface GranolaMeetingDetail {
  id?: unknown;
  title?: unknown;
  date?: unknown;
  attendees?: unknown;
  summary?: unknown;
  notes?: unknown;
  key_points?: unknown;
  transcript?: unknown;
  action_items?: unknown;
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
    const results = await this.callTool<GranolaMeetingResult[]>('list_meetings', {
      query,
      ...(options?.since && { since: options.since.toISOString() }),
      ...(options?.limit && { limit: options.limit }),
    });

    if (!results || !Array.isArray(results)) {
      return [];
    }

    return results.map((meeting) => normalizeMeetingSummary('granola', meeting));
  }

  private async getMeetingNotesMcp(meetingId: string): Promise<MeetingNotes | null> {
    const detail = await this.callTool<GranolaMeetingDetail>('get_meetings', { id: meetingId });

    if (!detail) {
      log.warn('Meeting not found via MCP', { meetingId });
      return null;
    }

    // Optionally fetch transcript (paid plan feature)
    let transcript = normalizeString(detail.transcript);
    if (!transcript) {
      const transcriptResult = await this.callTool<{ transcript?: string }>(
        'get_meeting_transcript',
        { id: meetingId },
      );
      transcript = normalizeString(transcriptResult?.transcript);
    }

    const actionItems = this.mapActionItems(detail.action_items, meetingId);

    return normalizeMeetingNotes({
      meetingId,
      title: detail.title,
      date: detail.date,
      attendees: detail.attendees,
      summary: firstString(detail.summary, detail.notes),
      keyPoints: normalizeTextArray(detail.key_points),
      actionItems,
      rawTranscript: transcript,
      source: 'granola',
    });
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

    const data = await this.restGet<GranolaMeetingResult[]>(`/v1/meetings?${params.toString()}`);

    if (!data || !Array.isArray(data)) {
      return [];
    }

    return data.map((meeting) => normalizeMeetingSummary('granola', meeting));
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

    return normalizeMeetingNotes({
      meetingId,
      title: detail.title,
      date: detail.date,
      attendees: detail.attendees,
      summary: firstString(detail.summary, detail.notes),
      keyPoints: normalizeTextArray(detail.key_points),
      actionItems,
      rawTranscript: detail.transcript,
      source: 'granola',
    });
  }

  private async restGet<T>(path: string): Promise<T | null> {
    try {
      const response = await fetch(`${GRANOLA_REST_BASE_URL}${path}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
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

  private mapActionItems(items: unknown, meetingId: string): ActionItem[] {
    return normalizeActionItems('granola', meetingId, items);
  }

  /**
   * Call an MCP tool with automatic 401 retry via token refresh.
   */
  private async callTool<T>(toolName: string, args: Record<string, unknown>): Promise<T | null> {
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
    const result = await withTimeout(
      this.client!.callTool({ name: toolName, arguments: args }),
      config.meetingMcpTimeoutMs,
      `Granola MCP tool "${toolName}" timed out`,
    );

    if (!result.content || !Array.isArray(result.content) || result.content.length === 0) {
      return null;
    }

    const textContent = result.content.find((c: { type: string }) => c.type === 'text') as
      | { type: 'text'; text: string }
      | undefined;

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
}
