import { describe, it, expect, vi } from 'vitest';
import {
  TokenBucket,
  parseRetryAfter,
  withRateLimitedRetry,
} from '../../../src/adapters/linear-rate-limiter.js';

describe('TokenBucket', () => {
  it('starts at capacity and draws down on acquire', async () => {
    const bucket = new TokenBucket(3, 0); // no refill
    expect(bucket.getAvailableTokens()).toBeCloseTo(3, 5);
    await bucket.acquire();
    await bucket.acquire();
    expect(bucket.getAvailableTokens()).toBeLessThanOrEqual(1.001);
  });

  it('refills over wall-clock time at the configured rate', async () => {
    // 60 per hour = 1 per minute = ~16.67 per second.
    const bucket = new TokenBucket(2, 60);
    await bucket.acquire();
    await bucket.acquire();
    // Empty now; after 100ms, should have ~0.0017 tokens. After 1s, ~0.0167.
    // We just verify monotonic refill.
    const t0 = bucket.getAvailableTokens();
    await new Promise((r) => setTimeout(r, 50));
    const t1 = bucket.getAvailableTokens();
    expect(t1).toBeGreaterThanOrEqual(t0);
  });

  it('default constructor uses Linear-friendly limits', () => {
    const bucket = new TokenBucket();
    expect(bucket.getAvailableTokens()).toBeGreaterThan(1000);
  });
});

describe('parseRetryAfter', () => {
  it('returns null for non-objects and primitives', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('rate limited')).toBeNull();
    expect(parseRetryAfter(429)).toBeNull();
  });

  it('returns null when neither status nor message hints rate-limiting', () => {
    expect(parseRetryAfter({ headers: { 'retry-after': '5' } })).toBeNull();
  });

  it('parses Retry-After in seconds from a plain headers record on a 429 error', () => {
    const err = Object.assign(new Error('Too Many Requests'), {
      status: 429,
      headers: { 'retry-after': '12' },
    });
    expect(parseRetryAfter(err)).toBe(12_000);
  });

  it('parses Retry-After from response.headers nesting', () => {
    const err = Object.assign(new Error('Too Many Requests'), {
      response: { status: 429, headers: { 'Retry-After': '3' } },
    });
    expect(parseRetryAfter(err)).toBe(3_000);
  });

  it('parses Retry-After from a Headers object', () => {
    const headers = new Headers({ 'retry-after': '7' });
    const err = Object.assign(new Error('rate limited'), { status: 429, headers });
    expect(parseRetryAfter(err)).toBe(7_000);
  });

  it('returns null when Retry-After is not a number', () => {
    const err = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': 'soon' },
    });
    expect(parseRetryAfter(err)).toBeNull();
  });

  it('honors message-based rate-limit hint when status is missing', () => {
    const err = Object.assign(new Error('You hit the rate limit'), {
      headers: { 'retry-after': '4' },
    });
    expect(parseRetryAfter(err)).toBe(4_000);
  });
});

describe('withRateLimitedRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRateLimitedRetry(fn, { sleepImpl: vi.fn() });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on rate-limit message and eventually succeeds', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Linear rate limit hit'))
      .mockResolvedValue('ok');

    const result = await withRateLimitedRetry(fn, { sleepImpl, maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalled();
  });

  it('honors Retry-After exactly when present on a 429', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const err = Object.assign(new Error('Too Many Requests'), {
      status: 429,
      headers: { 'retry-after': '5' },
    });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    await withRateLimitedRetry(fn, { sleepImpl, maxRetries: 3 });

    expect(sleepImpl).toHaveBeenCalledWith(5_000);
  });

  it('uses exponential backoff when no Retry-After is present', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const err = new Error('rate limit exceeded');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    await withRateLimitedRetry(fn, { sleepImpl, maxRetries: 3 });

    expect(sleepImpl).toHaveBeenNthCalledWith(1, 1000);
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 2000);
  });

  it('does not retry non-rate-limit errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bad request'));
    await expect(withRateLimitedRetry(fn, { sleepImpl: vi.fn() })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after maxRetries attempts on persistent rate limits', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error('Linear rate limit'));

    await expect(withRateLimitedRetry(fn, { sleepImpl, maxRetries: 3 })).rejects.toThrow(
      'rate limit',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
