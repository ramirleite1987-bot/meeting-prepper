import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../../src/config.js', () => ({
  config: {
    gogBin: 'gog',
    gogAccount: 'me@example.com',
  },
}));

const { GogExecutor } = await import('../../src/services/gog-executor.service.js');

describe('GogExecutor', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('parses valid JSON stdout and adds safe args', async () => {
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(null, { stdout: '{"ok":true}', stderr: '' });
    });

    const executor = new GogExecutor();
    await expect(executor.runJson<{ ok: boolean }>(['gmail', 'messages'])).resolves.toEqual({ ok: true });
    expect(execFileMock).toHaveBeenCalledWith(
      'gog',
      ['--account', 'me@example.com', 'gmail', 'messages', '--json', '--no-input'],
      expect.objectContaining({ timeout: 30000 }),
      expect.any(Function),
    );
  });

  it('reports missing gog binary', async () => {
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      callback(error);
    });

    const executor = new GogExecutor({ bin: '/missing/gog' });
    await expect(executor.runJson(['calendar'])).rejects.toThrow('/missing/gog');
  });

  it('surfaces stderr diagnostics from nonzero exits', async () => {
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(Object.assign(new Error('failed'), { stderr: 'auth required' }));
    });

    await expect(new GogExecutor().runJson(['gmail'])).rejects.toThrow('auth required');
  });

  it('rejects malformed JSON', async () => {
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(null, { stdout: 'not-json', stderr: '' });
    });

    await expect(new GogExecutor().runJson(['gmail'])).rejects.toThrow('malformed JSON');
  });
});

