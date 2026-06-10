import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

vi.mock('../../src/config.js', () => ({
  config: {
    anthropicApiKey: undefined,
    anthropicModel: 'claude-opus-4-8',
    selfIdentifiers: '',
    gogAccount: undefined,
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { LlmSynthesisService } = await import('../../src/services/llm-synthesis.service.js');

const synthesisInput = {
  clientName: 'Acme Corp',
  context: [
    {
      source: 'gmail',
      type: 'message' as const,
      title: 'Re: Proposal',
      content: 'We are reviewing the proposal and will respond by Friday.',
      timestamp: new Date(),
    },
  ],
  outstandingCommitments: [],
};

describe('LlmSynthesisService', () => {
  it('is unavailable without an API key and returns null', async () => {
    const service = new LlmSynthesisService();
    expect(service.isAvailable()).toBe(false);
    expect(await service.synthesizeBriefing(synthesisInput)).toBeNull();
    expect(
      await service.draftFollowUpEmail({
        clientName: 'Acme',
        meetingTitle: 'Kickoff',
        summary: '',
        decisions: [],
        risks: [],
        actionItems: [],
      }),
    ).toBeNull();
  });

  it('returns parsed synthesis from the Claude API', async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: {
        executiveSummary: 'Relationship is healthy.',
        talkingPoints: ['Discuss proposal feedback'],
        openThreads: ['Awaiting reply promised for Friday'],
      },
    });
    const client = { messages: { parse } } as unknown as Anthropic;
    const service = new LlmSynthesisService({ client });

    expect(service.isAvailable()).toBe(true);
    const result = await service.synthesizeBriefing(synthesisInput);

    expect(result?.executiveSummary).toBe('Relationship is healthy.');
    expect(result?.talkingPoints).toEqual(['Discuss proposal feedback']);
    expect(parse).toHaveBeenCalledOnce();
    const request = parse.mock.calls[0][0];
    expect(request.model).toBe('claude-opus-4-8');
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.messages[0].content).toContain('Acme Corp');
    expect(request.messages[0].content).toContain('Re: Proposal');
  });

  it('includes outstanding commitments in the synthesis prompt', async () => {
    const parse = vi.fn().mockResolvedValue({ parsed_output: null, stop_reason: 'end_turn' });
    const client = { messages: { parse } } as unknown as Anthropic;
    const service = new LlmSynthesisService({ client });

    await service.synthesizeBriefing({
      ...synthesisInput,
      outstandingCommitments: [
        {
          id: 'a1',
          title: 'Send proposal',
          owner: 'Ramir',
          ownerSide: 'ours',
          status: 'pending',
          deadline: null,
          meetingId: 'm1',
          meetingTitle: 'Kickoff',
          meetingScheduledAt: null,
        },
      ],
    });

    expect(parse.mock.calls[0][0].messages[0].content).toContain('[ours] Send proposal');
  });

  it('returns null when the API call fails', async () => {
    const parse = vi.fn().mockRejectedValue(new Error('boom'));
    const client = { messages: { parse } } as unknown as Anthropic;
    const service = new LlmSynthesisService({ client });

    expect(await service.synthesizeBriefing(synthesisInput)).toBeNull();
  });

  it('drafts an email body from text blocks', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Hi team,\n\nThanks for the meeting.' },
      ],
    });
    const client = { messages: { create } } as unknown as Anthropic;
    const service = new LlmSynthesisService({ client });

    const body = await service.draftFollowUpEmail({
      clientName: 'Acme Corp',
      meetingTitle: 'Kickoff',
      summary: 'Agreed on scope',
      decisions: ['Ship MVP in Q3'],
      risks: [],
      actionItems: [{ title: 'Send proposal', owner: 'Ramir', deadline: '2026-06-15' }],
    });

    expect(body).toBe('Hi team,\n\nThanks for the meeting.');
    const request = create.mock.calls[0][0];
    expect(request.messages[0].content).toContain('Ship MVP in Q3');
    expect(request.messages[0].content).toContain('Send proposal');
  });

  it('returns null when the email draft fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('rate limited'));
    const client = { messages: { create } } as unknown as Anthropic;
    const service = new LlmSynthesisService({ client });

    expect(
      await service.draftFollowUpEmail({
        clientName: 'Acme',
        meetingTitle: 'Kickoff',
        summary: '',
        decisions: [],
        risks: [],
        actionItems: [],
      }),
    ).toBeNull();
  });
});
