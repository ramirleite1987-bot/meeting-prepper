/**
 * Git/PR adapter for the Client Briefing Generator.
 * Stub implementation — returns empty results until Git integration is built.
 *
 * TODO: Implement Git log parsing and GitHub/GitLab PR API integration
 * TODO: Add authentication for remote repository APIs
 * TODO: Support filtering commits and PRs by client project or branch
 */

import type { IContextAdapter, ContextEntry } from './types.js';

export class GitAdapter implements IContextAdapter {
  readonly name = 'git';

  async initialize(): Promise<void> {
    // TODO: Initialize Git client and authenticate with remote APIs
  }

  async isAvailable(): Promise<boolean> {
    // TODO: Check for valid Git repository and API credentials
    return false;
  }

  async disconnect(): Promise<void> {
    // TODO: Clean up any open connections to remote APIs
  }

  async getClientContext(
    _clientName: string,
    _options?: { since?: Date; limit?: number },
  ): Promise<ContextEntry[]> {
    // TODO: Search commits and PRs for client-related changes
    return [];
  }
}
