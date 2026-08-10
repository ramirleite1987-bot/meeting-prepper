import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDueMeetings: Array<Record<string, unknown>> = [];
const mockReminderMeetings: Array<Record<string, unknown>> = [];
const markDelivered = vi.fn();
// Stateful stand-in for `reminder_sent_at`: once marked, the meeting no
// longer matches the due-for-reminder query (mirrors the SQL dedup).
const markReminderSent = vi.fn((id: string) => {
  const index = mockReminderMeetings.findIndex((row) => row.id === id);
  if (index >= 0) mockReminderMeetings.splice(index, 1);
});
const mockNotify = vi.fn().mockResolvedValue(undefined);
let reminderQueryWindow: { from: string; to: string } | null = null;

vi.mock('../../src/db/index.js', () => ({
  queries: {
    getMeetingsDueForBriefing: () => ({ all: () => mockDueMeetings }),
    markBriefingDelivered: () => ({ run: markDelivered }),
    getMeetingsDueForReminder: () => ({
      all: (params: { from: string; to: string }) => {
        reminderQueryWindow = params;
        return [...mockReminderMeetings];
      },
    }),
    markReminderSent: () => ({ run: markReminderSent }),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    schedulerIntervalMinutes: 5,
    briefingLeadMinutes: 60,
    reminderLeadMinutes: 15,
    linearReconcileIntervalMinutes: 30,
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../src/services/notification.service.js', () => ({
  notificationService: { notify: mockNotify },
}));

const { SchedulerService } = await import('../../src/services/scheduler.service.js');

function dueMeetingRow(id = 'm1'): Record<string, unknown> {
  return {
    id,
    client_id: 'c1',
    client_name: 'Acme Corp',
    title: 'Sprint Review',
    scheduled_at: '2026-06-10T15:00:00.000Z',
  };
}

function reminderMeetingRow(
  id = 'm1',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    client_id: 'c1',
    client_name: 'Acme Corp',
    title: 'Sprint Review',
    scheduled_at: '2026-06-10T15:00:00.000Z',
    needs_briefing: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockDueMeetings.length = 0;
  mockReminderMeetings.length = 0;
  reminderQueryWindow = null;
  markDelivered.mockClear();
  markReminderSent.mockClear();
  mockNotify.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SchedulerService', () => {
  it('generates and delivers briefings for due meetings', async () => {
    mockDueMeetings.push(dueMeetingRow());
    const generateBriefing = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerService({ generateBriefing });

    await scheduler.tick(new Date('2026-06-10T14:30:00.000Z'));

    expect(generateBriefing).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', clientId: 'c1', clientName: 'Acme Corp' }),
    );
    expect(markDelivered).toHaveBeenCalledWith('m1');
    expect(mockNotify).toHaveBeenCalledWith(
      'briefing_delivered',
      expect.stringContaining('Sprint Review'),
      expect.any(String),
      expect.objectContaining({ meetingId: 'm1', briefingUrl: '/briefing/m1' }),
    );
  });

  it('does not mark a meeting delivered when briefing generation fails', async () => {
    mockDueMeetings.push(dueMeetingRow());
    const generateBriefing = vi.fn().mockRejectedValue(new Error('context fetch failed'));
    const scheduler = new SchedulerService({ generateBriefing });

    await scheduler.tick();

    expect(markDelivered).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('continues with remaining meetings after one fails', async () => {
    mockDueMeetings.push(dueMeetingRow('m1'), dueMeetingRow('m2'));
    const generateBriefing = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const scheduler = new SchedulerService({ generateBriefing });

    await scheduler.tick();

    expect(generateBriefing).toHaveBeenCalledTimes(2);
    expect(markDelivered).toHaveBeenCalledTimes(1);
    expect(markDelivered).toHaveBeenCalledWith('m2');
  });

  it('runs Linear reconciliation only after the configured interval', async () => {
    const reconcileLinear = vi.fn().mockResolvedValue({ checked: 0, updated: 0, errors: [] });
    const scheduler = new SchedulerService(
      { generateBriefing: vi.fn(), reconcileLinear },
      { reconcileIntervalMs: 30 * 60_000 },
    );

    const t0 = new Date('2026-06-10T10:00:00.000Z');
    await scheduler.tick(t0);
    expect(reconcileLinear).toHaveBeenCalledTimes(1);

    // 5 minutes later: too soon
    await scheduler.tick(new Date(t0.getTime() + 5 * 60_000));
    expect(reconcileLinear).toHaveBeenCalledTimes(1);

    // 31 minutes later: due again
    await scheduler.tick(new Date(t0.getTime() + 31 * 60_000));
    expect(reconcileLinear).toHaveBeenCalledTimes(2);
  });

  it('survives reconciliation failures', async () => {
    const reconcileLinear = vi.fn().mockRejectedValue(new Error('linear down'));
    const scheduler = new SchedulerService({ generateBriefing: vi.fn(), reconcileLinear });

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  describe('pre-meeting reminders', () => {
    it('sends a reminder with a direct briefing link for imminent meetings', async () => {
      mockReminderMeetings.push(reminderMeetingRow());
      const generateBriefing = vi.fn().mockResolvedValue(undefined);
      const scheduler = new SchedulerService({ generateBriefing });

      await scheduler.tick(new Date('2026-06-10T14:48:00.000Z'));

      // Briefing already exists — the reminder must not regenerate it.
      expect(generateBriefing).not.toHaveBeenCalled();
      expect(markReminderSent).toHaveBeenCalledWith('m1');
      expect(mockNotify).toHaveBeenCalledWith(
        'meeting_reminder',
        expect.stringContaining('Sprint Review'),
        expect.stringContaining('starts in 12 min'),
        expect.objectContaining({
          meetingId: 'm1',
          briefingUrl: '/briefing/m1',
          startsInMinutes: 12,
        }),
      );
    });

    it('generates the briefing first when it is still missing', async () => {
      mockReminderMeetings.push(reminderMeetingRow('m1', { needs_briefing: 1 }));
      const generateBriefing = vi.fn().mockResolvedValue(undefined);
      const scheduler = new SchedulerService({ generateBriefing });

      await scheduler.tick(new Date('2026-06-10T14:50:00.000Z'));

      expect(generateBriefing).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm1', clientId: 'c1', clientName: 'Acme Corp' }),
      );
      expect(markReminderSent).toHaveBeenCalledWith('m1');
      expect(mockNotify).toHaveBeenCalledWith(
        'meeting_reminder',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ meetingId: 'm1' }),
      );
    });

    it('does not mark or notify when the fallback briefing generation fails', async () => {
      mockReminderMeetings.push(reminderMeetingRow('m1', { needs_briefing: 1 }));
      const generateBriefing = vi.fn().mockRejectedValue(new Error('context fetch failed'));
      const scheduler = new SchedulerService({ generateBriefing });

      await scheduler.tick(new Date('2026-06-10T14:50:00.000Z'));

      // Not marked as sent — the row stays due and a later tick retries.
      expect(markReminderSent).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockReminderMeetings).toHaveLength(1);
    });

    it('looks up meetings within the reminder lead window', async () => {
      const scheduler = new SchedulerService({ generateBriefing: vi.fn() });
      const now = new Date('2026-06-10T14:45:00.000Z');

      await scheduler.tick(now);

      expect(reminderQueryWindow).toEqual({
        from: new Date(now.getTime() - 10 * 60_000).toISOString(),
        to: new Date(now.getTime() + 15 * 60_000).toISOString(),
      });
    });

    it('never sends the same reminder twice across ticks', async () => {
      mockReminderMeetings.push(reminderMeetingRow());
      const scheduler = new SchedulerService({ generateBriefing: vi.fn() });
      const now = new Date('2026-06-10T14:50:00.000Z');

      await scheduler.tick(now);
      await scheduler.tick(now);
      await scheduler.tick(now);

      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(markReminderSent).toHaveBeenCalledTimes(1);
    });

    it('sends each reminder only once across timer ticks (fake timers)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-10T14:50:00.000Z'));
      mockReminderMeetings.push(reminderMeetingRow());
      const scheduler = new SchedulerService(
        { generateBriefing: vi.fn().mockResolvedValue(undefined) },
        { intervalMs: 60_000 },
      );

      try {
        scheduler.start(); // fires an immediate tick, then one per interval
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(mockNotify).toHaveBeenCalledTimes(1);
        expect(mockNotify).toHaveBeenCalledWith(
          'meeting_reminder',
          expect.any(String),
          expect.any(String),
          expect.objectContaining({ meetingId: 'm1', briefingUrl: '/briefing/m1' }),
        );
        expect(markReminderSent).toHaveBeenCalledTimes(1);
      } finally {
        scheduler.stop();
      }
    });
  });
});
