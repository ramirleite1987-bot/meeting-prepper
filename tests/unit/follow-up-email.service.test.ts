import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GogExecutor } from '../../src/services/gog-executor.service.js';
import type { LlmSynthesisService } from '../../src/services/llm-synthesis.service.js';

const mockMeeting: { value: Record<string, unknown> | undefined } = { value: undefined };
const mockActionItems: Array<Record<string, unknown>> = [];
const mockClient: { value: Record<string, unknown> | undefined } = { value: undefined };

vi.mock('../../src/db/index.js', () => ({
  queries: {
    getMeetingWithClient: () => ({ get: () => mockMeeting.value }),
    getActionItemsByMeeting: () => ({ all: () => mockActionItems }),
    getClientById: () => ({ get: () => mockClient.value }),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    gogBin: 'gog',
    gogAccount: undefined,
    anthropicApiKey: undefined,
    anthropicModel: 'claude-opus-4-8',
    selfIdentifiers: '',
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { FollowUpEmailService } = await import('../../src/services/follow-up-email.service.js');

function makeGog(runJson = vi.fn().mockResolvedValue({ id: 'draft-1' })): {
  gog: GogExecutor;
  runJson: ReturnType<typeof vi.fn>;
} {
  return { gog: { runJson } as unknown as GogExecutor, runJson };
}

function makeLlm(body: string | null): LlmSynthesisService {
  return {
    isAvailable: () => body !== null,
    draftFollowUpEmail: vi.fn().mockResolvedValue(body),
  } as unknown as LlmSynthesisService;
}

beforeEach(() => {
  mockMeeting.value = {
    id: 'm1',
    client_id: 'c1',
    client_name: 'Acme Corp',
    title: 'Sprint Review',
    post_call_notes: JSON.stringify({
      summary: 'Reviewed sprint outcomes',
      decisions: ['Ship v2 next week'],
      risks: ['API migration is behind'],
    }),
  };
  mockActionItems.length = 0;
  mockActionItems.push({
    title: 'Send release notes',
    owner: 'Ramir',
    deadline: '2026-06-15T00:00:00.000Z',
  });
  mockClient.value = {
    id: 'c1',
    aliases: JSON.stringify({ domains: [], emails: ['john@acme.com'], keywords: [] }),
  };
});

describe('FollowUpEmailService', () => {
  it('throws when the meeting does not exist', async () => {
    mockMeeting.value = undefined;
    const service = new FollowUpEmailService({ gog: makeGog().gog, llm: makeLlm(null) });
    await expect(service.draftForMeeting('missing')).rejects.toThrow('not found');
  });

  it('throws when no post-call notes exist', async () => {
    mockMeeting.value = { ...mockMeeting.value, post_call_notes: null };
    const service = new FollowUpEmailService({ gog: makeGog().gog, llm: makeLlm(null) });
    await expect(service.draftForMeeting('m1')).rejects.toThrow('extraction');
  });

  it('creates a Gmail draft with the template body when no LLM is available', async () => {
    const { gog, runJson } = makeGog();
    const service = new FollowUpEmailService({ gog, llm: makeLlm(null) });

    const result = await service.draftForMeeting('m1');

    expect(result.draftStatus).toBe('created');
    expect(result.draftId).toBe('draft-1');
    expect(result.bodySource).toBe('template');
    expect(result.to).toEqual(['john@acme.com']);
    expect(result.subject).toBe('Follow-up: Sprint Review');
    expect(result.body).toContain('Ship v2 next week');
    expect(result.body).toContain('Send release notes (Ramir) — due 2026-06-15');

    const args = runJson.mock.calls[0][0] as string[];
    expect(args.slice(0, 3)).toEqual(['gmail', 'drafts', 'create']);
    expect(args).toContain('john@acme.com');
  });

  it('prefers the LLM-drafted body when available', async () => {
    const service = new FollowUpEmailService({
      gog: makeGog().gog,
      llm: makeLlm('Custom LLM body'),
    });

    const result = await service.draftForMeeting('m1');
    expect(result.bodySource).toBe('llm');
    expect(result.body).toBe('Custom LLM body');
  });

  it('returns the body without a draft when the client has no alias emails', async () => {
    mockClient.value = { id: 'c1', aliases: '{"domains":[],"emails":[],"keywords":[]}' };
    const { gog, runJson } = makeGog();
    const service = new FollowUpEmailService({ gog, llm: makeLlm(null) });

    const result = await service.draftForMeeting('m1');
    expect(result.draftStatus).toBe('no_recipients');
    expect(result.body).toBeTruthy();
    expect(runJson).not.toHaveBeenCalled();
  });

  it('reports a failed draft but still returns the body', async () => {
    const { gog } = makeGog(vi.fn().mockRejectedValue(new Error('gog binary not found')));
    const service = new FollowUpEmailService({ gog, llm: makeLlm(null) });

    const result = await service.draftForMeeting('m1');
    expect(result.draftStatus).toBe('failed');
    expect(result.draftError).toContain('gog binary not found');
    expect(result.body).toContain('Sprint Review');
  });
});
