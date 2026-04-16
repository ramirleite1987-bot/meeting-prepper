import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KrispAdapter } from '../../../src/adapters/krisp.adapter.js';

// Mock MCP client - use vi.hoisted so variables are available in hoisted vi.mock factories
const { mockCallTool, mockClose } = vi.hoisted(() => ({
  mockCallTool: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('../../../src/utils/mcp-client.js', () => ({
  createMCPClient: vi.fn().mockResolvedValue({
    callTool: mockCallTool,
    close: mockClose,
  }),
}));

vi.mock('../../../src/config.js', () => ({
  config: { krispMcpServerUrl: 'http://localhost:3000' },
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

function mcpResponse(data: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

describe('KrispAdapter', () => {
  let adapter: KrispAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new KrispAdapter('http://localhost:3000');
  });

  describe('initialize and availability', () => {
    it('should initialize MCP client', async () => {
      await adapter.initialize();
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('should not be available before initialization', async () => {
      const a = new KrispAdapter(undefined);
      // serverUrl is undefined from constructor param, config mock returns a value
      // but with explicit undefined it won't initialize
      expect(await a.isAvailable()).toBe(false);
    });
  });

  describe('searchMeetings', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should return mapped meeting summaries', async () => {
      mockCallTool.mockResolvedValueOnce(
        mcpResponse([
          {
            id: 'm1',
            title: 'Standup',
            date: '2025-01-01T10:00:00Z',
            attendees: ['Alice'],
            duration_minutes: 15,
          },
          { id: 'm2', title: 'Retro', date: '2025-01-02T10:00:00Z', attendees: ['Bob'] },
        ]),
      );

      const results = await adapter.searchMeetings('standup');

      expect(results).toHaveLength(2);
      expect(results[0].meetingId).toBe('m1');
      expect(results[0].source).toBe('krisp');
      expect(results[0].durationMinutes).toBe(15);
    });

    it('should return empty array for empty results', async () => {
      mockCallTool.mockResolvedValueOnce(mcpResponse([]));
      const results = await adapter.searchMeetings('nothing');
      expect(results).toHaveLength(0);
    });

    it('should return empty array for null response', async () => {
      mockCallTool.mockResolvedValueOnce({ content: [] });
      const results = await adapter.searchMeetings('nothing');
      expect(results).toHaveLength(0);
    });
  });

  describe('getMeetingNotes - search→get_document chain', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should chain search → get_document → list_action_items', async () => {
      // search_meetings returns result with document_id
      mockCallTool.mockResolvedValueOnce(
        mcpResponse([{ id: 'm1', document_id: 'abcdef01234567890abcdef012345678' }]),
      );
      // get_document
      mockCallTool.mockResolvedValueOnce(
        mcpResponse({
          title: 'Sprint Planning',
          date: '2025-01-15T10:00:00Z',
          attendees: ['Alice', 'Bob'],
          summary: 'Planned sprint 5',
          key_points: ['Focus on auth'],
          decisions: ['Use OAuth'],
          risks: ['Timeline tight'],
        }),
      );
      // list_action_items
      mockCallTool.mockResolvedValueOnce(
        mcpResponse([
          {
            id: 'a1',
            title: 'Implement OAuth',
            assignee: 'Alice',
            priority: 'high',
            status: 'pending',
          },
        ]),
      );

      const notes = await adapter.getMeetingNotes('m1');

      expect(notes).not.toBeNull();
      expect(notes!.title).toBe('Sprint Planning');
      expect(notes!.keyPoints).toContain('Focus on auth');
      expect(notes!.keyPoints).toContain('Decision: Use OAuth');
      expect(notes!.keyPoints).toContain('Risk: Timeline tight');
      expect(notes!.actionItems).toHaveLength(1);
      expect(notes!.actionItems[0].priority).toBe('high');
      expect(notes!.source).toBe('krisp');
    });

    it('should return null when no document ID found', async () => {
      mockCallTool.mockResolvedValueOnce(mcpResponse([]));
      const notes = await adapter.getMeetingNotes('unknown-id');
      expect(notes).toBeNull();
    });

    it('should extract document ID from meetingId if it is a 32-char hex', async () => {
      const hexId = 'abcdef01234567890abcdef012345678';
      // search_meetings (still called but document ID extracted from meetingId)
      mockCallTool.mockResolvedValueOnce(mcpResponse([]));
      // get_document
      mockCallTool.mockResolvedValueOnce(mcpResponse({ title: 'Test', summary: 'Test meeting' }));
      // list_action_items
      mockCallTool.mockResolvedValueOnce(mcpResponse([]));

      const notes = await adapter.getMeetingNotes(hexId);
      expect(notes).not.toBeNull();
      expect(notes!.title).toBe('Test');
    });
  });

  describe('401 handling - token expired', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should retry on 401 unauthorized error', async () => {
      mockCallTool
        .mockRejectedValueOnce(new Error('401 Unauthorized'))
        .mockResolvedValueOnce(mcpResponse([{ id: 'm1', title: 'Retry Success' }]));

      const results = await adapter.searchMeetings('test');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Retry Success');
    });

    it('should return null when retry also fails', async () => {
      mockCallTool
        .mockRejectedValueOnce(new Error('401 Unauthorized'))
        .mockRejectedValueOnce(new Error('401 Unauthorized again'));

      const results = await adapter.searchMeetings('test');
      expect(results).toHaveLength(0);
    });

    it('should handle token expired message', async () => {
      mockCallTool
        .mockRejectedValueOnce(new Error('token expired'))
        .mockResolvedValueOnce(mcpResponse([{ id: 'm1', title: 'Refreshed' }]));

      const results = await adapter.searchMeetings('test');
      expect(results).toHaveLength(1);
    });
  });

  describe('getActionItems', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should map action items with correct priority and status', async () => {
      mockCallTool.mockResolvedValueOnce(
        mcpResponse([
          { id: 'a1', title: 'Task 1', priority: 'critical', status: 'done' },
          { id: 'a2', title: 'Task 2', priority: 'normal', status: 'in_progress' },
          { id: 'a3', title: 'Task 3', status: 'canceled' },
        ]),
      );

      const items = await adapter.getActionItems('m1');

      expect(items).toHaveLength(3);
      expect(items[0].priority).toBe('urgent');
      expect(items[0].status).toBe('completed');
      expect(items[1].priority).toBe('medium');
      expect(items[1].status).toBe('in-progress');
      expect(items[2].status).toBe('cancelled');
    });

    it('should return empty array for non-array response', async () => {
      mockCallTool.mockResolvedValueOnce({ content: [] });
      const items = await adapter.getActionItems('m1');
      expect(items).toHaveLength(0);
    });
  });

  describe('disconnect', () => {
    it('should close MCP client', async () => {
      await adapter.initialize();
      await adapter.disconnect();
      expect(mockClose).toHaveBeenCalled();
      expect(await adapter.isAvailable()).toBe(false);
    });
  });
});
