/**
 * MCP server exposing meeting-prepper data + actions to MCP clients
 * (Claude Code, Cursor, etc.). Each tool is a thin wrapper over the
 * existing services — never reimplement business logic here.
 *
 * Auth and transport are handled in cli.ts. This file is pure builder.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { queries } from '../db/index.js';
import { buildAgenda } from '../services/agenda.service.js';
import { buildStats } from '../services/stats.service.js';
import {
  listActionItems,
  listOwners,
  updateStatus,
  isValidStatus,
} from '../services/action-items.service.js';
import { search as runSearch } from '../services/search.service.js';

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export interface BuildMcpServerOptions {
  name?: string;
  version?: string;
}

/**
 * Build a configured McpServer instance ready to be `connect()`ed to a
 * transport. Pure builder — no listeners, no auth, no I/O until you
 * connect.
 */
export function createMcpServer(options: BuildMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name ?? 'meeting-prepper',
    version: options.version ?? '0.1.0',
  });

  // ──────────────────────────────────────────────────────
  // Read tools
  // ──────────────────────────────────────────────────────

  server.registerTool(
    'list_clients',
    {
      title: 'List clients',
      description: 'Return all clients tracked in meeting-prepper, most recently updated first.',
      inputSchema: {},
    },
    () => {
      const clients = queries.getAllClients().all();
      return jsonResult(clients);
    },
  );

  server.registerTool(
    'get_client_timeline',
    {
      title: 'Get client timeline',
      description:
        'Return the append-only event timeline (meetings, task updates, status changes) for a client.',
      inputSchema: {
        clientId: z.string().describe('Client ID (UUID).'),
      },
    },
    ({ clientId }) => {
      const rows = queries.getClientHistory().all(clientId);
      return jsonResult(rows);
    },
  );

  server.registerTool(
    'get_meeting',
    {
      title: 'Get meeting',
      description:
        'Return a meeting by ID, including its briefing and post-call notes if available.',
      inputSchema: {
        meetingId: z.string().describe('Meeting ID (UUID).'),
      },
    },
    ({ meetingId }) => {
      const meeting = queries.getMeetingById().get(meetingId);
      if (!meeting) {
        return errorResult(`No meeting found with id ${meetingId}`);
      }
      return jsonResult(meeting);
    },
  );

  server.registerTool(
    'list_meetings_by_client',
    {
      title: 'List meetings for a client',
      description: 'Return all meetings for a given client, most recently scheduled first.',
      inputSchema: {
        clientId: z.string().describe('Client ID (UUID).'),
      },
    },
    ({ clientId }) => {
      const rows = queries.getMeetingsByClient().all(clientId);
      return jsonResult(rows);
    },
  );

  server.registerTool(
    'get_upcoming_meetings',
    {
      title: 'Get upcoming meetings (agenda)',
      description:
        'Return the bucketed agenda (overdue, today, tomorrow, this_week, later, unscheduled) ' +
        'plus the next-up meeting hero card.',
      inputSchema: {},
    },
    () => jsonResult(buildAgenda()),
  );

  server.registerTool(
    'list_action_items',
    {
      title: 'List action items',
      description:
        'Return action items across all meetings, optionally filtered by status, priority, owner, ' +
        'client, or free-text query. Joins meeting and client metadata so the caller can act ' +
        'without extra lookups.',
      inputSchema: {
        status: z.string().optional().describe('"pending" | "synced" | "completed"'),
        priority: z.string().optional().describe('"high" | "medium" | "low"'),
        owner: z.string().optional().describe('Owner name (substring match).'),
        clientId: z.string().optional(),
        q: z.string().optional().describe('Free-text search across title and description.'),
      },
    },
    (args) => jsonResult(listActionItems(args)),
  );

  server.registerTool(
    'list_action_item_owners',
    {
      title: 'List action item owners',
      description: 'Return the distinct list of owners across all action items, for filtering UIs.',
      inputSchema: {},
    },
    () => jsonResult(listOwners()),
  );

  server.registerTool(
    'search',
    {
      title: 'Search clients, meetings, and action items',
      description:
        'Full-text-ish search across clients, meetings, and action items. Returns up to 25 ' +
        'results per type with highlight snippets.',
      inputSchema: {
        query: z.string().describe('Search query string.'),
      },
    },
    ({ query }) => jsonResult(runSearch(query)),
  );

  server.registerTool(
    'get_stats',
    {
      title: 'Get workspace stats',
      description:
        'Return KPI counters (meetings, briefings, action items, sync) for the dashboard.',
      inputSchema: {},
    },
    () => jsonResult(buildStats()),
  );

  // ──────────────────────────────────────────────────────
  // Write tools
  // ──────────────────────────────────────────────────────

  server.registerTool(
    'mark_action_item_status',
    {
      title: 'Update action item status',
      description: 'Update an action item status. Valid: "pending" | "synced" | "completed".',
      inputSchema: {
        actionItemId: z.string(),
        status: z.string().describe('"pending" | "synced" | "completed"'),
      },
    },
    ({ actionItemId, status }) => {
      if (!isValidStatus(status)) {
        return errorResult(
          `Invalid status "${status}". Must be one of: pending, synced, completed.`,
        );
      }
      const updated = updateStatus(actionItemId, status);
      if (!updated) {
        return errorResult(`No action item found with id ${actionItemId}`);
      }
      return jsonResult(updated);
    },
  );

  return server;
}
