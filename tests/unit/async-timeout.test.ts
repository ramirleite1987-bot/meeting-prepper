import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '../../src/utils/async-timeout.js';

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve when the operation finishes before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('done'), 100, 'timed out')).resolves.toBe('done');
  });

  it('should reject when the operation exceeds the timeout', async () => {
    vi.useFakeTimers();

    const result = withTimeout(new Promise(() => undefined), 50, 'MCP request timed out');
    const expectation = expect(result).rejects.toThrow('MCP request timed out');

    await vi.advanceTimersByTimeAsync(50);

    await expectation;
  });
});
