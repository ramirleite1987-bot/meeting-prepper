/**
 * Scheduler Service for the Client Briefing Generator.
 * Background loop with three jobs:
 *   1. Pre-meeting delivery — auto-generates the briefing for meetings
 *      starting within the lead window and pushes a notification through the
 *      configured channels (in-app SSE, console, webhook). Each meeting is
 *      delivered once, tracked via meetings.briefing_delivered_at.
 *   2. Pre-meeting reminder — shortly before start time (REMINDER_LEAD_MINUTES,
 *      default 15) ensures the briefing exists and sends a "starting soon"
 *      reminder with a direct briefing link. Fires once per meeting, tracked
 *      via meetings.reminder_sent_at, and never for meetings already marked
 *      in_progress/completed.
 *   3. Linear reconciliation — periodically pulls issue status back from
 *      Linear so locally tracked action items don't drift.
 */

import { config } from '../config.js';
import { queries } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { notificationService } from './notification.service.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface DueMeeting {
  id: string;
  clientId: string;
  clientName: string;
  title: string;
  scheduledAt: string;
}

export interface SchedulerDeps {
  /** Generates and stores the briefing for a due meeting. */
  generateBriefing: (meeting: DueMeeting) => Promise<void>;
  /** Pulls action-item status back from Linear. Omit when Linear is not configured. */
  reconcileLinear?: () => Promise<unknown>;
}

export interface SchedulerOptions {
  intervalMs?: number;
  briefingLeadMinutes?: number;
  reminderLeadMinutes?: number;
  reconcileIntervalMs?: number;
}

/** Meetings slightly in the past still get a briefing (clock skew, missed ticks). */
const PAST_GRACE_MINUTES = 10;

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class SchedulerService {
  private readonly log = logger.child('SchedulerService');
  private readonly deps: SchedulerDeps;
  private readonly intervalMs: number;
  private readonly briefingLeadMinutes: number;
  private readonly reminderLeadMinutes: number;
  private readonly reconcileIntervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastReconcileAt = 0;

  constructor(deps: SchedulerDeps, options: SchedulerOptions = {}) {
    this.deps = deps;
    this.intervalMs = options.intervalMs ?? config.schedulerIntervalMinutes * 60_000;
    this.briefingLeadMinutes = options.briefingLeadMinutes ?? config.briefingLeadMinutes;
    this.reminderLeadMinutes = options.reminderLeadMinutes ?? config.reminderLeadMinutes;
    this.reconcileIntervalMs =
      options.reconcileIntervalMs ?? config.linearReconcileIntervalMinutes * 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
    this.log.info('Scheduler started', {
      intervalMs: this.intervalMs,
      briefingLeadMinutes: this.briefingLeadMinutes,
      reminderLeadMinutes: this.reminderLeadMinutes,
      reconcileIntervalMs: this.reconcileIntervalMs,
    });
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info('Scheduler stopped');
    }
  }

  /** One scheduler pass. Public so tests (and ops) can trigger it directly. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return; // a slow previous tick is still in flight
    this.running = true;
    try {
      await this.deliverDueBriefings(now);
      await this.sendDueReminders(now);
      await this.maybeReconcileLinear(now);
    } catch (error) {
      this.log.error('Scheduler tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  // ──────────────────────────────────────────────
  // Jobs
  // ──────────────────────────────────────────────

  private async deliverDueBriefings(now: Date): Promise<void> {
    const from = new Date(now.getTime() - PAST_GRACE_MINUTES * 60_000).toISOString();
    const to = new Date(now.getTime() + this.briefingLeadMinutes * 60_000).toISOString();

    const rows = queries.getMeetingsDueForBriefing().all({ from, to }) as Array<
      Record<string, unknown>
    >;

    for (const row of rows) {
      const meeting: DueMeeting = {
        id: row.id as string,
        clientId: row.client_id as string,
        clientName: row.client_name as string,
        title: row.title as string,
        scheduledAt: row.scheduled_at as string,
      };

      try {
        await this.deps.generateBriefing(meeting);
        queries.markBriefingDelivered().run(meeting.id);
        await notificationService.notify(
          'briefing_delivered',
          `Briefing ready: ${meeting.title}`,
          `Pre-meeting briefing for ${meeting.clientName} (starts ${meeting.scheduledAt})`,
          {
            meetingId: meeting.id,
            clientId: meeting.clientId,
            clientName: meeting.clientName,
            scheduledAt: meeting.scheduledAt,
            briefingUrl: `/briefing/${meeting.id}`,
          },
        );
        this.log.info('Pre-meeting briefing delivered', { meetingId: meeting.id });
      } catch (error) {
        // Not marked delivered — the next tick retries.
        this.log.error('Failed to deliver pre-meeting briefing', {
          meetingId: meeting.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async sendDueReminders(now: Date): Promise<void> {
    const from = new Date(now.getTime() - PAST_GRACE_MINUTES * 60_000).toISOString();
    const to = new Date(now.getTime() + this.reminderLeadMinutes * 60_000).toISOString();

    const rows = queries.getMeetingsDueForReminder().all({ from, to }) as Array<
      Record<string, unknown>
    >;

    for (const row of rows) {
      const meeting: DueMeeting = {
        id: row.id as string,
        clientId: row.client_id as string,
        clientName: row.client_name as string,
        title: row.title as string,
        scheduledAt: row.scheduled_at as string,
      };
      const needsBriefing = Boolean(row.needs_briefing);

      try {
        // The delivery job normally generates the briefing well before this
        // point; this is the safety net for meetings that slipped through
        // (e.g. the process was down during the delivery window).
        if (needsBriefing) {
          await this.deps.generateBriefing(meeting);
        }
        // Marked before notifying so a reminder is never sent twice;
        // notification channels are best-effort (allSettled).
        queries.markReminderSent().run(meeting.id);
        const startsInMinutes = Math.round(
          (new Date(meeting.scheduledAt).getTime() - now.getTime()) / 60_000,
        );
        const timing =
          startsInMinutes >= 0
            ? `starts in ${startsInMinutes} min`
            : `started ${Math.abs(startsInMinutes)} min ago`;
        await notificationService.notify(
          'meeting_reminder',
          `⏰ Starting soon: ${meeting.title}`,
          `${meeting.clientName} call ${timing} (${meeting.scheduledAt}) — briefing is ready.`,
          {
            meetingId: meeting.id,
            clientId: meeting.clientId,
            clientName: meeting.clientName,
            scheduledAt: meeting.scheduledAt,
            startsInMinutes,
            briefingUrl: `/briefing/${meeting.id}`,
          },
        );
        this.log.info('Pre-meeting reminder sent', { meetingId: meeting.id });
      } catch (error) {
        // Not marked as sent — the next tick retries.
        this.log.error('Failed to send pre-meeting reminder', {
          meetingId: meeting.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async maybeReconcileLinear(now: Date): Promise<void> {
    if (!this.deps.reconcileLinear) return;
    if (now.getTime() - this.lastReconcileAt < this.reconcileIntervalMs) return;

    this.lastReconcileAt = now.getTime();
    try {
      await this.deps.reconcileLinear();
    } catch (error) {
      this.log.warn('Scheduled Linear reconciliation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
