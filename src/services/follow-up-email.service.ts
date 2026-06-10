/**
 * Follow-up Email Service for the Client Briefing Generator.
 * Composes a post-meeting recap email (LLM-drafted body with a deterministic
 * template fallback) and saves it as a Gmail draft via the gog CLI.
 * The email is always returned to the caller for review — it is never sent.
 */

import { queries } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { parseClientAliases } from './client-aliases.js';
import { GogExecutor } from './gog-executor.service.js';
import { LlmSynthesisService } from './llm-synthesis.service.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type DraftDeliveryStatus = 'created' | 'no_recipients' | 'failed';

export interface FollowUpEmailResult {
  meetingId: string;
  clientName: string;
  to: string[];
  subject: string;
  body: string;
  bodySource: 'llm' | 'template';
  draftStatus: DraftDeliveryStatus;
  draftId?: string;
  draftError?: string;
}

interface PostCallNotes {
  summary?: string;
  decisions?: string[];
  risks?: string[];
}

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class FollowUpEmailService {
  private readonly log = logger.child('FollowUpEmailService');
  private readonly gog: GogExecutor;
  private readonly llm: LlmSynthesisService;

  constructor(deps: { gog?: GogExecutor; llm?: LlmSynthesisService } = {}) {
    this.gog = deps.gog ?? new GogExecutor();
    this.llm = deps.llm ?? new LlmSynthesisService();
  }

  /**
   * Build the recap email for a completed meeting and create a Gmail draft.
   * Requires post-call notes (run extraction first).
   */
  async draftForMeeting(meetingId: string): Promise<FollowUpEmailResult> {
    const meeting = queries.getMeetingWithClient().get(meetingId) as
      | Record<string, unknown>
      | undefined;
    if (!meeting) {
      throw new Error(`Meeting ${meetingId} not found`);
    }
    if (!meeting.post_call_notes) {
      throw new Error('No post-call notes available — run extraction first');
    }

    const notes = this.parsePostCallNotes(meeting.post_call_notes as string);
    const clientName = (meeting.client_name as string) ?? 'client';
    const meetingTitle = meeting.title as string;

    const actionItems = (
      queries.getActionItemsByMeeting().all(meetingId) as Array<Record<string, unknown>>
    ).map((row) => ({
      title: row.title as string,
      owner: (row.owner as string | null) ?? undefined,
      deadline: row.deadline ? (row.deadline as string).slice(0, 10) : undefined,
    }));

    const to = this.resolveRecipients(meeting.client_id as string);
    const subject = `Follow-up: ${meetingTitle}`;

    const emailInput = {
      clientName,
      meetingTitle,
      summary: notes.summary ?? '',
      decisions: notes.decisions ?? [],
      risks: notes.risks ?? [],
      actionItems,
    };

    const llmBody = await this.llm.draftFollowUpEmail(emailInput);
    const body = llmBody ?? this.buildTemplateBody(emailInput);

    const result: FollowUpEmailResult = {
      meetingId,
      clientName,
      to,
      subject,
      body,
      bodySource: llmBody ? 'llm' : 'template',
      draftStatus: 'no_recipients',
    };

    if (to.length === 0) {
      this.log.info('No recipient emails on client aliases — returning body only', { meetingId });
      return result;
    }

    try {
      const draft = await this.gog.runJson<{ id?: string; draftId?: string }>([
        'gmail',
        'drafts',
        'create',
        '--to',
        to.join(','),
        '--subject',
        subject,
        '--body',
        body,
      ]);
      result.draftStatus = 'created';
      result.draftId = draft.id ?? draft.draftId;
      this.log.info('Gmail draft created', { meetingId, draftId: result.draftId });
    } catch (error) {
      result.draftStatus = 'failed';
      result.draftError = error instanceof Error ? error.message : String(error);
      this.log.warn('Failed to create Gmail draft — returning body only', {
        meetingId,
        error: result.draftError,
      });
    }

    return result;
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  private parsePostCallNotes(raw: string): PostCallNotes {
    try {
      return JSON.parse(raw) as PostCallNotes;
    } catch {
      return {};
    }
  }

  private resolveRecipients(clientId: string): string[] {
    const client = queries.getClientById().get(clientId) as Record<string, unknown> | undefined;
    if (!client) return [];
    const aliases = parseClientAliases(client.aliases);
    return aliases.emails;
  }

  private buildTemplateBody(input: {
    clientName: string;
    meetingTitle: string;
    summary: string;
    decisions: string[];
    risks: string[];
    actionItems: Array<{ title: string; owner?: string; deadline?: string }>;
  }): string {
    const lines: string[] = [
      `Hi ${input.clientName} team,`,
      '',
      `Thank you for the meeting "${input.meetingTitle}". Here is a quick recap:`,
    ];

    if (input.summary) {
      lines.push('', input.summary);
    }
    if (input.decisions.length > 0) {
      lines.push('', 'Decisions:');
      for (const d of input.decisions) lines.push(`- ${d}`);
    }
    if (input.risks.length > 0) {
      lines.push('', 'Risks / concerns:');
      for (const r of input.risks) lines.push(`- ${r}`);
    }
    if (input.actionItems.length > 0) {
      lines.push('', 'Next steps:');
      for (const item of input.actionItems) {
        const owner = item.owner ? ` (${item.owner})` : '';
        const deadline = item.deadline ? ` — due ${item.deadline}` : '';
        lines.push(`- ${item.title}${owner}${deadline}`);
      }
    }

    lines.push(
      '',
      'Please let me know if I missed anything or if any of the above needs correcting.',
      '',
      'Best regards',
    );

    return lines.join('\n');
  }
}
