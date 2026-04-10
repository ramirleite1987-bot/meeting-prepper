import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtractionService } from '../../src/services/extraction.service.js';
import type { IMeetingAdapter, MeetingNotes, ActionItem } from '../../src/adapters/types.js';

// Mock the database
vi.mock('../../src/db/index.js', () => ({
  getDb: () => ({
    transaction: (fn: Function) => fn,
    prepare: () => ({ run: vi.fn(), get: vi.fn() }),
    exec: vi.fn(),
  }),
  queries: {
    insertMeetingSource: () => ({ run: vi.fn() }),
    insertActionItem: () => ({ run: vi.fn() }),
    getActionItemByHash: () => ({ get: vi.fn(() => undefined) }),
    updateMeetingPostCall: () => ({ run: vi.fn() }),
  },
}));

// Mock the logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    info: vi.fn(),
  },
}));

// Mock the config
vi.mock('../../src/config.js', () => ({
  config: {
    logLevel: 'error',
    krispMcpServerUrl: undefined,
    granolaMcpServerUrl: undefined,
  },
}));

function createMockAdapter(
  name: string,
  notes: MeetingNotes | null,
  available = true,
): IMeetingAdapter {
  return {
    name,
    initialize: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(available),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getMeetingNotes: vi.fn().mockResolvedValue(notes),
    getActionItems: vi.fn().mockResolvedValue(notes?.actionItems ?? []),
    searchMeetings: vi.fn().mockResolvedValue([]),
  };
}

function makeNotes(overrides: Partial<MeetingNotes> = {}): MeetingNotes {
  return {
    meetingId: 'meeting-1',
    title: 'Weekly Sync',
    date: new Date(),
    attendees: ['Alice', 'Bob'],
    summary: 'Discussed project status',
    keyPoints: [],
    actionItems: [],
    source: 'test',
    ...overrides,
  };
}

function makeActionItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    title: 'Fix bug',
    status: 'pending' as const,
    source: 'test',
    ...overrides,
  };
}

describe('ExtractionService', () => {
  describe('extract with Krisp-like adapter', () => {
    it('should extract notes from a single source', async () => {
      const notes = makeNotes({
        source: 'krisp',
        summary: 'Krisp summary',
        keyPoints: ['Decision: Use React', 'Risk: Timeline tight'],
        actionItems: [makeActionItem({ title: 'Migrate to React', source: 'krisp' })],
      });

      const adapter = createMockAdapter('krisp', notes);
      const service = new ExtractionService([adapter]);

      const result = await service.extract('meeting-1');

      expect(result.meetingId).toBe('meeting-1');
      expect(result.mergedSummary).toBe('Krisp summary');
      expect(result.decisions).toContain('Use React');
      expect(result.risks).toContain('Timeline tight');
      expect(result.actionItems).toHaveLength(1);
      expect(result.sources).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('source merging', () => {
    it('should merge summaries from multiple sources', async () => {
      const krispNotes = makeNotes({ source: 'krisp', summary: 'Krisp view' });
      const granolaNotes = makeNotes({ source: 'granola', summary: 'Granola view' });

      const service = new ExtractionService([
        createMockAdapter('krisp', krispNotes),
        createMockAdapter('granola', granolaNotes),
      ]);

      const result = await service.extract('meeting-1');

      expect(result.mergedSummary).toContain('[krisp] Krisp view');
      expect(result.mergedSummary).toContain('[granola] Granola view');
      expect(result.sources).toHaveLength(2);
    });

    it('should merge decisions and risks from multiple sources', async () => {
      const krispNotes = makeNotes({
        source: 'krisp',
        keyPoints: ['Decision: Use TypeScript'],
      });
      const granolaNotes = makeNotes({
        source: 'granola',
        keyPoints: ['Risk: Budget overrun'],
      });

      const service = new ExtractionService([
        createMockAdapter('krisp', krispNotes),
        createMockAdapter('granola', granolaNotes),
      ]);

      const result = await service.extract('meeting-1');

      expect(result.decisions).toContain('Use TypeScript');
      expect(result.risks).toContain('Budget overrun');
    });

    it('should deduplicate decisions case-insensitively', async () => {
      const notes1 = makeNotes({
        source: 'krisp',
        keyPoints: ['Decision: Use React'],
      });
      const notes2 = makeNotes({
        source: 'granola',
        keyPoints: ['Decision: use react'],
      });

      const service = new ExtractionService([
        createMockAdapter('krisp', notes1),
        createMockAdapter('granola', notes2),
      ]);

      const result = await service.extract('meeting-1');

      expect(result.decisions).toHaveLength(1);
    });
  });

  describe('deduplication', () => {
    it('should deduplicate action items with similar titles and same assignee', async () => {
      const notes = makeNotes({
        source: 'krisp',
        actionItems: [
          makeActionItem({ title: 'Fix the auth bug', assignee: 'Alice', source: 'krisp' }),
          makeActionItem({ title: 'Fix the auth bug', assignee: 'Alice', source: 'granola' }),
        ],
      });

      const service = new ExtractionService([createMockAdapter('krisp', notes)]);
      const result = await service.extract('meeting-1');

      expect(result.actionItems).toHaveLength(1);
    });

    it('should keep action items with different assignees', async () => {
      const notes = makeNotes({
        source: 'krisp',
        actionItems: [
          makeActionItem({ title: 'Fix the auth bug', assignee: 'Alice', source: 'krisp' }),
          makeActionItem({ title: 'Fix the auth bug', assignee: 'Bob', source: 'granola' }),
        ],
      });

      const service = new ExtractionService([createMockAdapter('krisp', notes)]);
      const result = await service.extract('meeting-1');

      expect(result.actionItems).toHaveLength(2);
    });

    it('should prefer the more detailed duplicate when merging', async () => {
      const notes = makeNotes({
        source: 'krisp',
        actionItems: [
          makeActionItem({ title: 'Fix bug', description: 'short', source: 'krisp' }),
          makeActionItem({
            title: 'Fix bug',
            description: 'A much longer and more detailed description of the bug',
            dueDate: new Date('2025-01-01'),
            priority: 'high',
            source: 'granola',
          }),
        ],
      });

      const service = new ExtractionService([createMockAdapter('krisp', notes)]);
      const result = await service.extract('meeting-1');

      expect(result.actionItems).toHaveLength(1);
      expect(result.actionItems[0].description).toContain('longer');
      expect(result.actionItems[0].dueDate).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should handle adapter failures gracefully', async () => {
      const failingAdapter: IMeetingAdapter = {
        name: 'failing',
        initialize: vi.fn().mockRejectedValue(new Error('Init failed')),
        isAvailable: vi.fn().mockResolvedValue(true),
        disconnect: vi.fn(),
        getMeetingNotes: vi.fn().mockRejectedValue(new Error('Fetch failed')),
        getActionItems: vi.fn().mockResolvedValue([]),
        searchMeetings: vi.fn().mockResolvedValue([]),
      };

      const goodNotes = makeNotes({ source: 'krisp', summary: 'Good data' });
      const service = new ExtractionService([
        failingAdapter,
        createMockAdapter('krisp', goodNotes),
      ]);

      const result = await service.extract('meeting-1');

      expect(result.sources).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].source).toBe('failing');
    });

    it('should handle unavailable adapters', async () => {
      const unavailable = createMockAdapter('unavailable', makeNotes(), false);
      const service = new ExtractionService([unavailable]);

      const result = await service.extract('meeting-1');

      // Unavailable adapter returns null from fetchFromAdapter, which is filtered out
      expect(result.sources).toHaveLength(0);
      expect(result.mergedSummary).toBe('');
    });

    it('should return empty results when all adapters fail', async () => {
      const failing: IMeetingAdapter = {
        name: 'broken',
        initialize: vi.fn().mockResolvedValue(undefined),
        isAvailable: vi.fn().mockResolvedValue(true),
        disconnect: vi.fn(),
        getMeetingNotes: vi.fn().mockRejectedValue(new Error('Broken')),
        getActionItems: vi.fn().mockResolvedValue([]),
        searchMeetings: vi.fn().mockResolvedValue([]),
      };

      const service = new ExtractionService([failing]);
      const result = await service.extract('meeting-1');

      expect(result.mergedSummary).toBe('');
      expect(result.actionItems).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('metadata extraction', () => {
    it('should extract decisions from metadata', async () => {
      const notes = makeNotes({
        source: 'granola',
        keyPoints: [],
        metadata: { decisions: ['Use Postgres', 'Ship by Q2'] },
      });

      const service = new ExtractionService([createMockAdapter('granola', notes)]);
      const result = await service.extract('meeting-1');

      expect(result.decisions).toContain('Use Postgres');
      expect(result.decisions).toContain('Ship by Q2');
    });

    it('should extract risks from metadata', async () => {
      const notes = makeNotes({
        source: 'granola',
        keyPoints: [],
        metadata: { risks: ['Budget overrun', 'Staffing gap'] },
      });

      const service = new ExtractionService([createMockAdapter('granola', notes)]);
      const result = await service.extract('meeting-1');

      expect(result.risks).toContain('Budget overrun');
      expect(result.risks).toContain('Staffing gap');
    });
  });
});
