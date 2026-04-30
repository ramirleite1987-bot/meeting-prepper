import { describe, it, expect } from 'vitest';
import { formatBriefingAsMarkdown } from '../../src/services/briefing-export.service.js';

const meeting = {
  id: 'm1',
  title: 'Acme weekly sync',
  client_name: 'Acme',
  scheduled_at: '2026-04-30T10:00:00Z',
  status: 'scheduled',
};

describe('formatBriefingAsMarkdown', () => {
  it('renders the flat shape (executiveSummary, keyTopics, etc.)', () => {
    const md = formatBriefingAsMarkdown(meeting, {
      executiveSummary: 'Quarterly check-in.',
      keyTopics: ['Roadmap', 'Renewal'],
      talkingPoints: ['Confirm scope'],
      actionItems: ['Send proposal'],
      risks: [],
    });

    expect(md).toContain('# Acme weekly sync');
    expect(md).toContain('**Client:** Acme');
    expect(md).toContain('## Executive Summary');
    expect(md).toContain('Quarterly check-in.');
    expect(md).toContain('## Key Topics');
    expect(md).toContain('- Roadmap');
    expect(md).toContain('- Renewal');
    expect(md).toContain('- Send proposal');
    expect(md).not.toContain('## Risks');
  });

  it('renders the nested sections shape from BriefingService', () => {
    const md = formatBriefingAsMarkdown(meeting, {
      sections: {
        lastDeliveries: { title: 'Last Deliveries', items: ['[git] feat: shipped v2'] },
        suggestedNextSteps: { title: 'Suggested Next Steps', items: ['Review backlog'] },
        recommendedQuestions: { title: 'Recommended Questions', items: [] },
      },
    });

    expect(md).toContain('## Last Deliveries');
    expect(md).toContain('- [git] feat: shipped v2');
    expect(md).toContain('## Suggested Next Steps');
    expect(md).not.toContain('## Recommended Questions');
  });

  it('falls back to placeholder when briefing is empty', () => {
    const md = formatBriefingAsMarkdown(meeting, {});
    expect(md).toContain('# Acme weekly sync');
    expect(md).toContain('_No briefing content available._');
  });

  it('escapes nothing destructive but preserves text', () => {
    const md = formatBriefingAsMarkdown(meeting, {
      executiveSummary: 'Use **markdown** freely; tables: |a|b|',
    });
    expect(md).toContain('Use **markdown** freely');
  });
});
