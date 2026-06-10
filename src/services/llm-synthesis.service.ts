/**
 * LLM Synthesis Service for the Client Briefing Generator.
 * Uses the Claude API to turn aggregated client context into a narrative
 * briefing (executive summary, talking points, open threads) and to draft
 * follow-up emails. Degrades gracefully: when ANTHROPIC_API_KEY is not
 * configured every method reports unavailable / returns null and callers
 * fall back to heuristic output.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// The SDK's zod helper is typed against zod v4; the project's zod 3.25+
// exposes it via the /v4 subpath while the rest of the app stays on v3.
import { z } from 'zod/v4';
import type { ContextEntry } from '../adapters/types.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { OutstandingCommitment } from './commitments.service.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface BriefingSynthesis {
  executiveSummary: string;
  talkingPoints: string[];
  openThreads: string[];
}

export interface BriefingSynthesisInput {
  clientName: string;
  context: ContextEntry[];
  outstandingCommitments: OutstandingCommitment[];
}

export interface FollowUpEmailInput {
  clientName: string;
  meetingTitle: string;
  summary: string;
  decisions: string[];
  risks: string[];
  actionItems: Array<{ title: string; owner?: string; deadline?: string }>;
}

const briefingSynthesisSchema = z.object({
  executiveSummary: z
    .string()
    .describe('2-4 sentence narrative summary of where the client relationship stands'),
  talkingPoints: z
    .array(z.string())
    .describe('Concrete, prioritized talking points for the upcoming meeting'),
  openThreads: z
    .array(z.string())
    .describe('Unresolved topics from previous interactions that deserve follow-up'),
});

const MAX_CONTEXT_ENTRIES = 40;
const MAX_ENTRY_CONTENT_CHARS = 600;

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class LlmSynthesisService {
  private readonly log = logger.child('LlmSynthesisService');
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(options: { client?: Anthropic; model?: string } = {}) {
    this.model = options.model ?? config.anthropicModel;
    if (options.client) {
      this.client = options.client;
    } else if (config.anthropicApiKey) {
      this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    } else {
      this.client = null;
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Synthesize a narrative briefing from raw context. Returns null when the
   * LLM is unavailable or the request fails — callers must treat synthesis
   * as optional enrichment, never a hard dependency.
   */
  async synthesizeBriefing(input: BriefingSynthesisInput): Promise<BriefingSynthesis | null> {
    if (!this.client) return null;

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system:
          'You prepare consultants for client meetings. You receive raw context ' +
          '(emails, meeting notes, tasks, commits, calendar events) about one client ' +
          'and produce a sharp, specific pre-meeting briefing. Be concrete: reference ' +
          'actual items from the context, never generic advice. Write in the same ' +
          'language the source material is predominantly written in.',
        messages: [
          {
            role: 'user',
            content: this.buildSynthesisPrompt(input),
          },
        ],
        output_config: {
          format: zodOutputFormat(briefingSynthesisSchema),
        },
      });

      if (!response.parsed_output) {
        this.log.warn('Briefing synthesis returned no parseable output', {
          stopReason: response.stop_reason,
        });
        return null;
      }

      return response.parsed_output;
    } catch (error) {
      this.logApiError('Briefing synthesis failed', error);
      return null;
    }
  }

  /**
   * Draft the body of a follow-up email after a meeting. Returns null when
   * the LLM is unavailable or errors; the caller falls back to a template.
   */
  async draftFollowUpEmail(input: FollowUpEmailInput): Promise<string | null> {
    if (!this.client) return null;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system:
          'You write concise, professional follow-up emails after client meetings. ' +
          'Respond with the email body only — no subject line, no preamble, no ' +
          'commentary, no signature placeholders beyond a simple closing. Write in ' +
          'the same language the meeting notes are written in.',
        messages: [
          {
            role: 'user',
            content: this.buildEmailPrompt(input),
          },
        ],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      return text || null;
    } catch (error) {
      this.logApiError('Follow-up email draft failed', error);
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // Prompt builders
  // ──────────────────────────────────────────────

  private buildSynthesisPrompt(input: BriefingSynthesisInput): string {
    const lines: string[] = [`Client: ${input.clientName}`, ''];

    if (input.outstandingCommitments.length > 0) {
      lines.push('Outstanding commitments from previous meetings (still open):');
      for (const c of input.outstandingCommitments) {
        const due = c.deadline ? `, due ${c.deadline}` : '';
        lines.push(`- [${c.ownerSide}] ${c.title} (from "${c.meetingTitle}"${due})`);
      }
      lines.push('');
    }

    lines.push(`Recent context (${Math.min(input.context.length, MAX_CONTEXT_ENTRIES)} entries):`);
    for (const entry of input.context.slice(0, MAX_CONTEXT_ENTRIES)) {
      const content = entry.content.slice(0, MAX_ENTRY_CONTENT_CHARS).replace(/\s+/g, ' ').trim();
      lines.push(`- [${entry.source}/${entry.type}] ${entry.title}: ${content}`);
    }

    lines.push('');
    lines.push(
      'Produce the briefing: an executive summary of where this relationship stands, ' +
        'the talking points that matter most for the next meeting, and open threads ' +
        'that risk being dropped.',
    );

    return lines.join('\n');
  }

  private buildEmailPrompt(input: FollowUpEmailInput): string {
    const lines: string[] = [
      `Write a follow-up email to the client "${input.clientName}" after the meeting "${input.meetingTitle}".`,
      '',
      `Meeting summary: ${input.summary || '(no summary captured)'}`,
    ];

    if (input.decisions.length > 0) {
      lines.push('', 'Decisions made:');
      for (const d of input.decisions) lines.push(`- ${d}`);
    }
    if (input.risks.length > 0) {
      lines.push('', 'Risks raised:');
      for (const r of input.risks) lines.push(`- ${r}`);
    }
    if (input.actionItems.length > 0) {
      lines.push('', 'Action items:');
      for (const item of input.actionItems) {
        const owner = item.owner ? ` (owner: ${item.owner})` : '';
        const deadline = item.deadline ? ` (due: ${item.deadline})` : '';
        lines.push(`- ${item.title}${owner}${deadline}`);
      }
    }

    lines.push(
      '',
      'The email should thank them for the meeting, recap decisions and next steps ' +
        'with owners and deadlines, and invite corrections.',
    );

    return lines.join('\n');
  }

  private logApiError(message: string, error: unknown): void {
    if (error instanceof Anthropic.APIError) {
      this.log.error(message, { status: error.status, error: error.message });
    } else {
      this.log.error(message, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
