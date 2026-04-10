/**
 * Telegram adapter for the Client Briefing Generator.
 * Stub implementation — returns empty results until Telegram integration is built.
 *
 * TODO: Implement Telegram Bot API or MTProto client to fetch messages
 * TODO: Add authentication and session management
 * TODO: Support searching messages by client name across configured channels/groups
 */

import type { IContextAdapter, ContextEntry } from './types.js';

export class TelegramAdapter implements IContextAdapter {
  readonly name = 'telegram';

  async initialize(): Promise<void> {
    // TODO: Initialize Telegram client and authenticate
  }

  async isAvailable(): Promise<boolean> {
    // TODO: Check for valid Telegram credentials and connectivity
    return false;
  }

  async disconnect(): Promise<void> {
    // TODO: Disconnect Telegram client and clean up session
  }

  async getClientContext(
    _clientName: string,
    _options?: { since?: Date; limit?: number },
  ): Promise<ContextEntry[]> {
    // TODO: Search Telegram messages for client-related conversations
    return [];
  }
}
