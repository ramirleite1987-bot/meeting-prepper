/**
 * Local rate-limit awareness for the Linear adapter.
 *
 * Linear's HTTP API rate-limits API-key auth at ~1500 req/h. When you
 * hit it, the SDK propagates a 429 with `Retry-After` (seconds). The
 * old `withRetry` helper used blind exponential backoff and ignored
 * the `Retry-After` header, so a burst of bulk syncs would retry at
 * the wrong cadence and either give up early (good outcome lost) or
 * keep hammering (bad outcome amplified).
 *
 * This module provides:
 *
 *   1. `TokenBucket` — a tiny in-process pre-throttle that smooths
 *      bursts to the configured average rate. Cheap insurance against
 *      ever hitting 429 in the first place.
 *
 *   2. `parseRetryAfter(error)` — best-effort extraction of the
 *      Retry-After hint from various error shapes the SDK might throw.
 *      Returns milliseconds to wait, or null if no hint was present.
 *
 *   3. `withRateLimitedRetry(...)` — drop-in replacement for the old
 *      withRetry. Acquires a token before each attempt, retries on
 *      rate-limit errors using `Retry-After` when available, falls
 *      back to exponential backoff otherwise.
 */

import { logger } from '../utils/logger.js';

const log = logger.child('LinearRateLimiter');

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple token bucket. Tokens refill continuously at `refillPerHour`
 * and the bucket holds at most `capacity` tokens. `acquire()` removes
 * one token, waiting if none is available.
 *
 * Defaults match Linear's documented limits (1500 req/h, burst 1500).
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  /** Tokens generated per millisecond. */
  private readonly refillPerMs: number;

  constructor(capacity = 1500, refillPerHour = 1500) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerHour / (60 * 60 * 1000);
    this.lastRefill = Date.now();
  }

  /**
   * Acquire 1 token. Resolves immediately if a token is available;
   * otherwise sleeps just long enough for one to be generated.
   */
  async acquire(now: () => number = Date.now): Promise<void> {
    this.refill(now());
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await sleep(waitMs);
    this.refill(now());
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /** Visible for testing. */
  getAvailableTokens(): number {
    this.refill(Date.now());
    return this.tokens;
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
}

/**
 * Pull a Retry-After (in milliseconds) out of whatever shape the
 * upstream SDK threw. Linear's GraphQL client wraps errors variably
 * across versions: sometimes the response is on `error.response`,
 * sometimes the headers are a `Headers` object, sometimes a plain
 * record. Be permissive — false negatives are fine (we just fall back
 * to exponential backoff), false positives are not.
 *
 * Returns null when no Retry-After could be parsed, including when
 * the error isn't rate-limit-shaped.
 */
export function parseRetryAfter(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;

  type ErrorShape = {
    status?: number;
    statusCode?: number;
    headers?: Headers | Record<string, string | string[] | undefined>;
    response?: {
      status?: number;
      statusCode?: number;
      headers?: Headers | Record<string, string | string[] | undefined>;
    };
  };
  const e = error as ErrorShape;

  const status = e.status ?? e.statusCode ?? e.response?.status ?? e.response?.statusCode;
  const headers = e.headers ?? e.response?.headers;

  // We only honor Retry-After on rate-limit-shaped errors. Some 5xx
  // errors include Retry-After but blindly trusting them is unsafe.
  const isRateLimitStatus = status === 429;
  const messageHints =
    error instanceof Error &&
    (error.message.toLowerCase().includes('rate limit') ||
      error.message.toLowerCase().includes('too many requests'));

  if (!isRateLimitStatus && !messageHints) return null;
  if (!headers) return null;

  let raw: string | undefined;
  if (typeof (headers as Headers).get === 'function') {
    raw = (headers as Headers).get('retry-after') ?? undefined;
  } else {
    const rec = headers as Record<string, string | string[] | undefined>;
    const v = rec['retry-after'] ?? rec['Retry-After'];
    raw = Array.isArray(v) ? v[0] : v;
  }
  if (!raw) return null;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

export interface RetryOptions {
  maxRetries?: number;
  bucket?: TokenBucket;
  /** Override sleep for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Run `fn` with a token from the local rate limiter. On rate-limit
 * errors, sleep for `Retry-After` (when present) or exponential backoff
 * otherwise, then retry up to `maxRetries` times.
 */
export async function withRateLimitedRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const bucket = options.bucket;
  const doSleep = options.sleepImpl ?? sleep;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (bucket) {
      await bucket.acquire();
    }
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      if (attempt === maxRetries - 1) {
        throw error;
      }

      const retryAfterMs = parseRetryAfter(error);
      if (retryAfterMs !== null) {
        log.warn('Rate limited; honoring Retry-After', {
          retryAfterMs,
          attempt: attempt + 1,
          maxRetries,
        });
        await doSleep(retryAfterMs);
        continue;
      }

      const isRateLimit =
        error instanceof Error && error.message.toLowerCase().includes('rate limit');
      if (!isRateLimit) {
        throw error;
      }

      const backoffMs = Math.pow(2, attempt) * 1000;
      log.warn('Rate limited; using exponential backoff', {
        backoffMs,
        attempt: attempt + 1,
        maxRetries,
      });
      await doSleep(backoffMs);
    }
  }
  throw lastError;
}
