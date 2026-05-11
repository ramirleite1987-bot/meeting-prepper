import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinearContextService } from '../../src/services/linear-context.service.js';

const upsertExternalContext = vi.fn();

vi.mock('../../src/db/index.js', () => ({
  queries: {
    upsertExternalContext: () => ({
      run: upsertExternalContext,
    }),
  },
}));

function makeAdapter() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getProjectContext: vi.fn().mockResolvedValue({
      project: {
        id: 'project-1',
        name: 'Implementation',
        description: 'Delivery work',
        content: 'Current scope',
        url: 'https://linear.app/project/implementation',
        updatedAt: new Date('2025-01-03'),
      },
      issues: [
        {
          id: 'issue-1',
          identifier: 'ENG-42',
          title: 'Ship onboarding',
          description: 'Finish onboarding flow',
          url: 'https://linear.app/team/ENG-42',
          updatedAt: new Date('2025-01-04'),
        },
      ],
    }),
  };
}

describe('LinearContextService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('imports selected Linear project overview and issues as client context', async () => {
    const adapter = makeAdapter();
    const service = new LinearContextService(adapter);

    const result = await service.importProjectContext('client-1', 'project-1');

    expect(adapter.initialize).toHaveBeenCalledOnce();
    expect(adapter.getProjectContext).toHaveBeenCalledWith('project-1');
    expect(result).toEqual({ imported: 2, projectId: 'project-1' });
    expect(upsertExternalContext).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client-1',
        source: 'linear',
        externalId: 'project:project-1',
        title: 'Linear project: Implementation',
        content: expect.stringContaining('Current scope'),
      }),
    );
    expect(upsertExternalContext).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client-1',
        source: 'linear',
        externalId: 'issue:issue-1',
        title: 'ENG-42: Ship onboarding',
        content: expect.stringContaining('Finish onboarding flow'),
      }),
    );
  });
});
