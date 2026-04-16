/**
 * Briefing Service for the Client Briefing Generator.
 * Takes aggregated client context and generates a structured
 * pre-meeting briefing with actionable sections.
 */

import type { ContextEntry } from '../adapters/types.js';
import { getDb } from '../db/index.js';
import { logger } from '../utils/logger.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface BriefingSection {
  title: string;
  items: string[];
}

export interface Briefing {
  clientName: string;
  meetingId: string;
  generatedAt: Date;
  sections: {
    lastDeliveries: BriefingSection;
    openItemsAndRisks: BriefingSection;
    recentAgreements: BriefingSection;
    suggestedNextSteps: BriefingSection;
    recommendedQuestions: BriefingSection;
  };
}

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class BriefingService {
  private readonly log = logger.child('BriefingService');

  /**
   * Generate a structured briefing from aggregated context entries.
   * Stores the briefing JSON in the meetings table and returns it.
   */
  async generateBriefing(
    meetingId: string,
    clientName: string,
    context: ContextEntry[],
  ): Promise<Briefing> {
    this.log.info('Generating briefing', { meetingId, clientName, contextSize: context.length });

    const briefing: Briefing = {
      clientName,
      meetingId,
      generatedAt: new Date(),
      sections: {
        lastDeliveries: this.extractLastDeliveries(context),
        openItemsAndRisks: this.extractOpenItemsAndRisks(context),
        recentAgreements: this.extractRecentAgreements(context),
        suggestedNextSteps: this.deriveSuggestedNextSteps(context),
        recommendedQuestions: this.deriveRecommendedQuestions(context),
      },
    };

    this.storeBriefing(meetingId, briefing);

    this.log.info('Briefing generated successfully', { meetingId });
    return briefing;
  }

  /**
   * Extract recent deliveries from commits, tasks, and notes
   * mentioning deliverables or completions.
   */
  private extractLastDeliveries(context: ContextEntry[]): BriefingSection {
    const deliveryTypes = new Set<string>(['commit', 'task']);
    const deliveryKeywords = /deliver|ship|release|deploy|complet|done|finish|launch/i;

    const items = context
      .filter(
        (e) =>
          deliveryTypes.has(e.type) ||
          deliveryKeywords.test(e.title) ||
          deliveryKeywords.test(e.content),
      )
      .slice(0, 10)
      .map((e) => `[${e.source}] ${e.title}`);

    return { title: 'Last Deliveries', items };
  }

  /**
   * Extract open items and risks from context entries
   * that reference pending work, blockers, or risk indicators.
   */
  private extractOpenItemsAndRisks(context: ContextEntry[]): BriefingSection {
    const riskKeywords = /risk|block|issue|bug|problem|delay|concern|pending|overdue|stuck/i;

    const items = context
      .filter((e) => riskKeywords.test(e.title) || riskKeywords.test(e.content))
      .slice(0, 10)
      .map((e) => `[${e.source}] ${e.title}`);

    return { title: 'Open Items & Risks', items };
  }

  /**
   * Extract recent agreements from meeting notes and messages
   * that indicate decisions or commitments.
   */
  private extractRecentAgreements(context: ContextEntry[]): BriefingSection {
    const agreementKeywords = /agree|decide|confirm|approve|commit|accept|sign.?off|align/i;
    const agreementTypes = new Set<string>(['note', 'message']);

    const items = context
      .filter(
        (e) =>
          agreementTypes.has(e.type) &&
          (agreementKeywords.test(e.title) || agreementKeywords.test(e.content)),
      )
      .slice(0, 10)
      .map((e) => `[${e.source}] ${e.title}`);

    return { title: 'Recent Agreements', items };
  }

  /**
   * Derive suggested next steps based on open items,
   * recent activity patterns, and upcoming events.
   */
  private deriveSuggestedNextSteps(context: ContextEntry[]): BriefingSection {
    const items: string[] = [];

    // Suggest follow-up on pending tasks
    const pendingTasks = context.filter(
      (e) => e.type === 'task' && /pending|todo|backlog/i.test(e.content),
    );
    for (const task of pendingTasks.slice(0, 5)) {
      items.push(`Follow up on: ${task.title}`);
    }

    // Suggest reviewing recent deliveries
    const recentCommits = context.filter((e) => e.type === 'commit');
    if (recentCommits.length > 0) {
      items.push(`Review ${recentCommits.length} recent deliveries/commits`);
    }

    // Suggest addressing risks
    const risks = context.filter(
      (e) => /risk|block|issue/i.test(e.title) || /risk|block|issue/i.test(e.content),
    );
    if (risks.length > 0) {
      items.push(`Address ${risks.length} open risk(s) or blocker(s)`);
    }

    // Suggest reviewing upcoming events
    const upcomingEvents = context.filter((e) => e.type === 'event');
    if (upcomingEvents.length > 0) {
      items.push(`Prepare for ${upcomingEvents.length} upcoming event(s)`);
    }

    return { title: 'Suggested Next Steps', items };
  }

  /**
   * Derive recommended questions to ask during the meeting
   * based on gaps in context and recent activity.
   */
  private deriveRecommendedQuestions(context: ContextEntry[]): BriefingSection {
    const items: string[] = [];

    // Questions about pending items
    const pendingTasks = context.filter(
      (e) => e.type === 'task' && /pending|todo|backlog/i.test(e.content),
    );
    if (pendingTasks.length > 0) {
      items.push(`What is the current status of the ${pendingTasks.length} pending item(s)?`);
    }

    // Questions about risks
    const risks = context.filter(
      (e) => /risk|block/i.test(e.title) || /risk|block/i.test(e.content),
    );
    if (risks.length > 0) {
      items.push('Are there any new blockers or risks since the last meeting?');
    }

    // Questions about recent deliveries
    const deliveries = context.filter((e) => e.type === 'commit');
    if (deliveries.length > 0) {
      items.push('How is the client responding to the recent deliveries?');
    }

    // General questions when context is sparse
    if (context.length < 3) {
      items.push('What are the current priorities and expectations?');
      items.push('Are there any upcoming deadlines we should be aware of?');
    }

    // Always useful
    items.push('What are the key outcomes expected from this meeting?');

    return { title: 'Recommended Questions', items };
  }

  /**
   * Persist the briefing JSON to the meetings table
   * and update briefing_generated_at timestamp.
   */
  private storeBriefing(meetingId: string, briefing: Briefing): void {
    try {
      const db = getDb();
      const stmt = db.prepare(
        'UPDATE meetings SET briefing = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      );
      stmt.run(JSON.stringify(briefing), meetingId);
    } catch (error) {
      this.log.error('Failed to store briefing', {
        meetingId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
