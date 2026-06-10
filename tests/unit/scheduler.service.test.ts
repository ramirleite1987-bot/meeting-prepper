import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDueMeetings: Array<Record<string, unknown>> = [];
const markDelivered = vi.fn();
const mockNotify = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/index.js', () => ({
  queries: {
    getMeetingsDueForBriefing: () => ({ all: () => mockDueMeetings }),
    markBriefingDelivered: () => ({ run: markDelivered }),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    schedulerIntervalMinutes: 5,
    briefingLeadMinutes: 60,
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

beforeEach(() => {
  mockDueMeetings.length = 0;
  markDelivered.mockClear();
  mockNotify.mockClear();
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
});
