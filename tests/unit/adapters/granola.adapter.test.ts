import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GranolaAdapter } from '../../../src/adapters/granola.adapter.js';

// Mock MCP client
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock('../../../src/utils/mcp-client.js', () => ({
  createMCPClient: vi.fn().mockResolvedValue({
    callTool: mockCallTool,
    close: mockClose,
  }),
}));

vi.mock('../../../src/config.js', () => ({
  config: { granolaMcpServerUrl: undefined },
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

describe('GranolaAdapter', () => {
  let adapter: GranolaAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GRANOLA_API_KEY;
    adapter = new GranolaAdapter('http://localhost:3001');
  });

  describe('initialize and availability', () => {
    it('should initialize MCP client', async () => {
      await adapter.initialize();
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('should not be available without server URL or API key', async () => {
      const a = new GranolaAdapter(undefined, undefined);
      await a.initialize();
      expect(await a.isAvailable()).toBe(false);
    });

    it('should be available with API key only (REST fallback)', async () => {
      const a = new GranolaAdapter(undefined, 'test-api-key');
      await a.initialize();
      expect(await a.isAvailable()).toBe(true);
    });
  });

  describe('searchMeetings (MCP)', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should list meetings and return summaries', async () => {
      mockCallTool.mockResolvedValueOnce(
        mcpResponse([
          { id: 'g1', title: 'Weekly Sync', date: '2025-01-10T14:00:00Z', attendees: ['Alice', 'Bob'], duration_minutes: 30 },
          { id: 'g2', title: 'One-on-one', date: '2025-01-11T10:00:00Z', attendees: ['Charlie'] },
        ]),
      );

      const results = await adapter.searchMeetings('weekly');

      expect(results).toHaveLength(2);
      expect(results[0].meetingId).toBe('g1');
      expect(results[0].source).toBe('granola');
      expect(results[0].durationMinutes).toBe(30);
      expect(results[1].attendees).toEqual(['Charlie']);
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

  describe('getMeetingNotes (MCP)', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should get meeting details with action items', async () => {
      // get_meetings
      mockCallTool.mockResolvedValueOnce(
        mcpResponse({
          id: 'g1',
          title: 'Sprint Review',
          date: '2025-01-15T14:00:00Z',
          attendees: ['Alice'],
          summary: 'Reviewed sprint goals',
          key_points: ['Goal A met'],
          transcript: 'Full transcript...',
          action_items: [
            { id: 'a1', title: 'Follow up on Goal B', assignee: 'Alice', priority: 'high', status: 'pending' },
          ],
        }),
      );

      const notes = await adapter.getMeetingNotes('g1');

      expect(notes).not.toBeNull();
      expect(notes!.title).toBe('Sprint Review');
      expect(notes!.summary).toBe('Reviewed sprint goals');
      expect(notes!.actionItems).toHaveLength(1);
      expect(notes!.actionItems[0].priority).toBe('high');
      expect(notes!.rawTranscript).toBe('Full transcript...');
      expect(notes!.source).toBe('granola');
    });

    it('should fetch transcript separately when not in detail', async () => {
      // get_meetings (no transcript)
      mockCallTool.mockResolvedValueOnce(
        mcpResponse({ id: 'g1', title: 'Meeting', summary: 'Notes' }),
      );
      // get_meeting_transcript
      mockCallTool.mockResolvedValueOnce(
        mcpResponse({ transcript: 'Fetched transcript' }),
      );

      const notes = await adapter.getMeetingNotes('g1');

      expect(notes!.rawTranscript).toBe('Fetched transcript');
      expect(mockCallTool).toHaveBeenCalledTimes(2);
    });

    it('should return null when meeting not found', async () => {
      mockCallTool.mockResolvedValueOnce({ content: [] });
      const notes = await adapter.getMeetingNotes('nonexistent');
      expect(notes).toBeNull();
    });
  });

  describe('getActionItems', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should return action items from getMeetingNotes', async () => {
      mockCallTool.mockResolvedValueOnce(
        mcpResponse({
          id: 'g1',
          title: 'Meeting',
          action_items: [
            { title: 'Task 1', status: 'done' },
            { title: 'Task 2', status: 'in_progress', priority: 'urgent' },
          ],
        }),
      );

      const items = await adapter.getActionItems('g1');

      expect(items).toHaveLength(2);
      expect(items[0].status).toBe('completed');
      expect(items[1].priority).toBe('urgent');
      expect(items[1].status).toBe('in-progress');
    });

    it('should return empty array when no meeting found', async () => {
      mockCallTool.mockResolvedValueOnce({ content: [] });
      const items = await adapter.getActionItems('nonexistent');
      expect(items).toHaveLength(0);
    });
  });

  describe('free plan limits (transcript not available)', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should handle null transcript gracefully', async () => {
      // get_meetings - no transcript
      mockCallTool.mockResolvedValueOnce(
        mcpResponse({ id: 'g1', title: 'Meeting', summary: 'Notes' }),
      );
      // get_meeting_transcript returns null
      mockCallTool.mockResolvedValueOnce({ content: [] });

      const notes = await adapter.getMeetingNotes('g1');

      expect(notes).not.toBeNull();
      expect(notes!.rawTranscript).toBeUndefined();
    });
  });

  describe('REST API fallback', () => {
    let restAdapter: GranolaAdapter;

    beforeEach(() => {
      restAdapter = new GranolaAdapter(undefined, 'test-api-key');
      // Don't initialize MCP - it will use REST
      vi.spyOn(globalThis, 'fetch').mockImplementation(vi.fn());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should search meetings via REST', async () => {
      await restAdapter.initialize();

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          { id: 'r1', title: 'REST Meeting', date: '2025-01-01T10:00:00Z', attendees: [] },
        ]),
      });

      const results = await restAdapter.searchMeetings('test');

      expect(results).toHaveLength(1);
      expect(results[0].meetingId).toBe('r1');
      expect(results[0].source).toBe('granola');
    });

    it('should return empty on REST error', async () => {
      await restAdapter.initialize();

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const results = await restAdapter.searchMeetings('test');
      expect(results).toHaveLength(0);
    });
  });

  describe('401 handling', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should retry on token expired error', async () => {
      mockCallTool
        .mockRejectedValueOnce(new Error('401 Unauthorized'))
        .mockResolvedValueOnce(mcpResponse([{ id: 'g1', title: 'After Refresh' }]));

      const results = await adapter.searchMeetings('test');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('After Refresh');
    });

    it('should return empty when retry also fails', async () => {
      mockCallTool
        .mockRejectedValueOnce(new Error('unauthorized'))
        .mockRejectedValueOnce(new Error('unauthorized'));

      const results = await adapter.searchMeetings('test');
      expect(results).toHaveLength(0);
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
