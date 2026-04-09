import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BriefingService } from '../../src/services/briefing.service.js';
import type { ContextEntry } from '../../src/adapters/types.js';

// Mock the database
vi.mock('../../src/db/index.js', () => ({
  getDb: () => ({
    prepare: () => ({
      run: vi.fn(),
    }),
  }),
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
  },
}));

function makeEntry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    source: 'test',
    type: 'other',
    title: 'Test entry',
    content: 'Test content',
    timestamp: new Date(),
    ...overrides,
  };
}

describe('BriefingService', () => {
  let service: BriefingService;

  beforeEach(() => {
    service = new BriefingService();
  });

  describe('generateBriefing', () => {
    it('should return a briefing with all sections', async () => {
      const context: ContextEntry[] = [
        makeEntry({ type: 'commit', title: 'Shipped v2.0', source: 'git' }),
        makeEntry({ type: 'task', title: 'Bug blocking release', content: 'blocked' }),
        makeEntry({ type: 'note', title: 'Agreed on timeline', content: 'decided to ship Q1', source: 'obsidian' }),
        makeEntry({ type: 'task', title: 'Pending review', content: 'pending task in backlog' }),
        makeEntry({ type: 'event', title: 'Sprint planning', source: 'calendar' }),
      ];

      const briefing = await service.generateBriefing('meeting-1', 'Acme Corp', context);

      expect(briefing.clientName).toBe('Acme Corp');
      expect(briefing.meetingId).toBe('meeting-1');
      expect(briefing.generatedAt).toBeInstanceOf(Date);
      expect(briefing.sections.lastDeliveries).toBeDefined();
      expect(briefing.sections.openItemsAndRisks).toBeDefined();
      expect(briefing.sections.recentAgreements).toBeDefined();
      expect(briefing.sections.suggestedNextSteps).toBeDefined();
      expect(briefing.sections.recommendedQuestions).toBeDefined();
    });

    it('should extract deliveries from commits and tasks with delivery keywords', async () => {
      const context: ContextEntry[] = [
        makeEntry({ type: 'commit', title: 'feat: add auth', source: 'git' }),
        makeEntry({ type: 'task', title: 'Deploy v3', source: 'linear' }),
        makeEntry({ type: 'note', title: 'Released dashboard', content: 'release notes' }),
      ];

      const briefing = await service.generateBriefing('m1', 'Client', context);
      const items = briefing.sections.lastDeliveries.items;

      // commit type always included, "Deploy" matches keyword, "Released" matches keyword
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(items.some((i) => i.includes('git'))).toBe(true);
    });

    it('should extract open items and risks', async () => {
      const context: ContextEntry[] = [
        makeEntry({ title: 'Risk: data loss possible', content: 'needs attention' }),
        makeEntry({ title: 'Normal task', content: 'nothing special' }),
        makeEntry({ title: 'Blocked by API', content: 'blocker' }),
      ];

      const briefing = await service.generateBriefing('m1', 'Client', context);
      const items = briefing.sections.openItemsAndRisks.items;

      expect(items.length).toBe(2);
      expect(items.some((i) => i.includes('Risk'))).toBe(true);
    });

    it('should extract agreements from notes/messages only', async () => {
      const context: ContextEntry[] = [
        makeEntry({ type: 'note', title: 'Agreed on deadline', content: 'confirmed Q2' }),
        makeEntry({ type: 'commit', title: 'Agreed refactor', content: 'agreed' }),
        makeEntry({ type: 'message', title: 'Decision confirmed', content: 'approved by client' }),
      ];

      const briefing = await service.generateBriefing('m1', 'Client', context);
      const items = briefing.sections.recentAgreements.items;

      // Only note and message types with agreement keywords
      expect(items.length).toBe(2);
    });

    it('should derive next steps from pending tasks, commits, risks, events', async () => {
      const context: ContextEntry[] = [
        makeEntry({ type: 'task', title: 'Fix auth', content: 'pending review' }),
        makeEntry({ type: 'commit', title: 'Update docs', source: 'git' }),
        makeEntry({ title: 'Risk: timeline slip', content: 'risk of delay' }),
        makeEntry({ type: 'event', title: 'Demo call' }),
      ];

      const briefing = await service.generateBriefing('m1', 'Client', context);
      const items = briefing.sections.suggestedNextSteps.items;

      expect(items.some((i) => i.includes('Follow up on'))).toBe(true);
      expect(items.some((i) => i.includes('deliveries'))).toBe(true);
      expect(items.some((i) => i.includes('risk'))).toBe(true);
      expect(items.some((i) => i.includes('event'))).toBe(true);
    });

    it('should handle empty context gracefully', async () => {
      const briefing = await service.generateBriefing('m1', 'Client', []);

      expect(briefing.sections.lastDeliveries.items).toHaveLength(0);
      expect(briefing.sections.openItemsAndRisks.items).toHaveLength(0);
      expect(briefing.sections.recentAgreements.items).toHaveLength(0);
      expect(briefing.sections.suggestedNextSteps.items).toHaveLength(0);
      // Sparse context should generate general questions
      expect(briefing.sections.recommendedQuestions.items.length).toBeGreaterThan(0);
    });

    it('should generate extra questions when context is sparse', async () => {
      const context: ContextEntry[] = [
        makeEntry({ type: 'note', title: 'Quick sync', content: 'brief update' }),
      ];

      const briefing = await service.generateBriefing('m1', 'Client', context);
      const questions = briefing.sections.recommendedQuestions.items;

      expect(questions.some((q) => q.includes('priorities'))).toBe(true);
      expect(questions.some((q) => q.includes('deadlines'))).toBe(true);
    });

    it('should always include the key outcomes question', async () => {
      const briefing = await service.generateBriefing('m1', 'Client', []);
      const questions = briefing.sections.recommendedQuestions.items;

      expect(questions.some((q) => q.includes('key outcomes'))).toBe(true);
    });
  });
});
