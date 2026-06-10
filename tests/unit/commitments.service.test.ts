import { describe, it, expect, vi } from 'vitest';

const mockCommitmentRows: Array<Record<string, unknown>> = [];

vi.mock('../../src/db/index.js', () => ({
  queries: {
    getOutstandingCommitmentsByClient: () => ({
      all: vi.fn().mockReturnValue(mockCommitmentRows),
    }),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    selfIdentifiers: 'Ramir,ramirleite1987@gmail.com',
    gogAccount: undefined,
  },
}));

const { classifyOwnerSide, CommitmentsService } =
  await import('../../src/services/commitments.service.js');

describe('classifyOwnerSide', () => {
  it('classifies a configured identifier as ours', () => {
    expect(classifyOwnerSide('Ramir')).toBe('ours');
    expect(classifyOwnerSide('ramirleite1987@gmail.com')).toBe('ours');
  });

  it('matches case-insensitively and partially', () => {
    expect(classifyOwnerSide('RAMIR')).toBe('ours');
    expect(classifyOwnerSide('Ramir Leite')).toBe('ours');
  });

  it('classifies other owners as theirs', () => {
    expect(classifyOwnerSide('John from Acme')).toBe('theirs');
  });

  it('classifies missing owners as unknown', () => {
    expect(classifyOwnerSide(undefined)).toBe('unknown');
    expect(classifyOwnerSide(null)).toBe('unknown');
    expect(classifyOwnerSide('  ')).toBe('unknown');
  });
});

describe('CommitmentsService', () => {
  it('maps rows to commitments and falls back to owner classification', () => {
    mockCommitmentRows.length = 0;
    mockCommitmentRows.push(
      {
        id: 'a1',
        title: 'Send proposal',
        owner: 'Ramir',
        owner_side: 'unknown',
        status: 'pending',
        deadline: '2026-06-15T00:00:00.000Z',
        meeting_id: 'm1',
        meeting_title: 'Kickoff',
        meeting_scheduled_at: '2026-06-01T10:00:00.000Z',
      },
      {
        id: 'a2',
        title: 'Share API docs',
        owner: 'John',
        owner_side: 'theirs',
        status: 'synced',
        deadline: null,
        meeting_id: 'm1',
        meeting_title: 'Kickoff',
        meeting_scheduled_at: null,
      },
    );

    const service = new CommitmentsService();
    const commitments = service.getOutstandingCommitments('c1', 'm2');

    expect(commitments).toHaveLength(2);
    expect(commitments[0].ownerSide).toBe('ours');
    expect(commitments[1].ownerSide).toBe('theirs');
    expect(commitments[0].meetingTitle).toBe('Kickoff');
  });

  it('formats briefing items with ours first', () => {
    const service = new CommitmentsService();
    const items = service.formatAsBriefingItems([
      {
        id: 'a2',
        title: 'Share API docs',
        owner: 'John',
        ownerSide: 'theirs',
        status: 'pending',
        deadline: null,
        meetingId: 'm1',
        meetingTitle: 'Kickoff',
        meetingScheduledAt: null,
      },
      {
        id: 'a1',
        title: 'Send proposal',
        owner: 'Ramir',
        ownerSide: 'ours',
        status: 'pending',
        deadline: '2026-06-15T00:00:00.000Z',
        meetingId: 'm1',
        meetingTitle: 'Kickoff',
        meetingScheduledAt: null,
      },
    ]);

    expect(items[0]).toContain('We promised: Send proposal');
    expect(items[0]).toContain('due 2026-06-15');
    expect(items[1]).toContain('They promised: Share API docs');
  });

  it('caps briefing items at the limit', () => {
    const service = new CommitmentsService();
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `a${i}`,
      title: `Item ${i}`,
      owner: null,
      ownerSide: 'unknown' as const,
      status: 'pending',
      deadline: null,
      meetingId: 'm1',
      meetingTitle: 'Kickoff',
      meetingScheduledAt: null,
    }));
    expect(service.formatAsBriefingItems(many)).toHaveLength(10);
  });
});
