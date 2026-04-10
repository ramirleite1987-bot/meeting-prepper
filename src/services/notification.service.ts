/**
 * Notification Service for the Client Briefing Generator.
 * Sends notifications about project changes via configured channels.
 * Supports: in-app events, webhook (generic), and console logging.
 */

import { logger } from '../utils/logger.js';

const log = logger.child('NotificationService');

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type NotificationType =
  | 'briefing_generated'
  | 'extraction_completed'
  | 'action_item_synced'
  | 'linear_status_change'
  | 'sync_error'
  | 'system_health';

export interface Notification {
  type: NotificationType;
  title: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface NotificationChannel {
  name: string;
  send(notification: Notification): Promise<void>;
}

// ──────────────────────────────────────────────
// Channels
// ──────────────────────────────────────────────

class ConsoleChannel implements NotificationChannel {
  readonly name = 'console';

  async send(notification: Notification): Promise<void> {
    log.info(`[${notification.type}] ${notification.title}`, {
      message: notification.message,
      ...notification.metadata,
    });
  }
}

class WebhookChannel implements NotificationChannel {
  readonly name = 'webhook';
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async send(notification: Notification): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: notification.type,
          title: notification.title,
          message: notification.message,
          timestamp: notification.timestamp.toISOString(),
          ...notification.metadata,
        }),
      });

      if (!response.ok) {
        log.warn('Webhook notification failed', {
          status: response.status,
          url: this.url,
        });
      }
    } catch (error) {
      log.error('Webhook notification error', {
        url: this.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ──────────────────────────────────────────────
// In-app event store (for SSE/polling)
// ──────────────────────────────────────────────

const MAX_EVENTS = 100;

class InAppChannel implements NotificationChannel {
  readonly name = 'in-app';
  private events: Notification[] = [];
  private listeners: Set<(notification: Notification) => void> = new Set();

  async send(notification: Notification): Promise<void> {
    this.events.push(notification);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
    for (const listener of this.listeners) {
      listener(notification);
    }
  }

  getRecent(limit = 20): Notification[] {
    return this.events.slice(-limit).reverse();
  }

  subscribe(listener: (notification: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class NotificationService {
  private channels: NotificationChannel[] = [];
  private inAppChannel: InAppChannel;

  constructor() {
    this.inAppChannel = new InAppChannel();
    this.channels.push(new ConsoleChannel());
    this.channels.push(this.inAppChannel);

    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      this.channels.push(new WebhookChannel(webhookUrl));
      log.info('Webhook notification channel configured', { url: webhookUrl });
    }
  }

  async notify(
    type: NotificationType,
    title: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const notification: Notification = {
      type,
      title,
      message,
      timestamp: new Date(),
      metadata,
    };

    await Promise.allSettled(
      this.channels.map((channel) => channel.send(notification)),
    );
  }

  getRecentNotifications(limit = 20): Notification[] {
    return this.inAppChannel.getRecent(limit);
  }

  subscribe(listener: (notification: Notification) => void): () => void {
    return this.inAppChannel.subscribe(listener);
  }
}

export const notificationService = new NotificationService();
