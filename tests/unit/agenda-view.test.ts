/**
 * View tests for the agenda "starting soon" badge (issue #13, optional UI
 * signal): meetings in `scheduled` status starting within the configured
 * REMINDER_LEAD_MINUTES window get a "⏰ in N min" badge.
 */
import { describe, expect, it } from 'vitest';
import type { AgendaMeeting, AgendaResponse } from '../../src/services/agenda.service.js';

const { buildAgendaViewData } = await import('../../src/routes/view-renderers/agenda.js');

function meeting(overrides: Partial<AgendaMeeting> = {}): AgendaMeeting {
  return {
    id: 'm1',
    title: 'Sprint Review',
    status: 'scheduled',
    scheduled_at: '2026-06-10T15:00:00.000Z',
    client_id: 'c1',
    client_name: 'Acme Corp',
    has_briefing: true,
    has_post_call: false,
    bucket: 'today',
    starts_in_minutes: 10,
    ...overrides,
  };
}

function agendaWith(meetings: AgendaMeeting[]): AgendaResponse {
  return {
    generatedAt: '2026-06-10T14:50:00.000Z',
    next: null,
    buckets: [{ bucket: 'today', label: 'Today', count: meetings.length, meetings }],
  };
}

describe('buildAgendaViewData starting-soon badge', () => {
  it('badges scheduled meetings starting within the reminder lead window', () => {
    const { bucketsHtml } = buildAgendaViewData(agendaWith([meeting({ starts_in_minutes: 10 })]));

    expect(bucketsHtml).toContain('⏰ in 10 min');
  });

  it('omits the badge beyond the reminder lead window', () => {
    const { bucketsHtml } = buildAgendaViewData(agendaWith([meeting({ starts_in_minutes: 45 })]));

    expect(bucketsHtml).not.toContain('⏰');
  });

  it('omits the badge for meetings already in progress or completed', () => {
    const { bucketsHtml } = buildAgendaViewData(
      agendaWith([
        meeting({ id: 'm1', status: 'in_progress', starts_in_minutes: 5 }),
        meeting({ id: 'm2', status: 'completed', starts_in_minutes: 5 }),
      ]),
    );

    expect(bucketsHtml).not.toContain('⏰');
  });
});
