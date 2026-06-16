const DEFAULT_TIMEOUT_MS = 10_000;

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  message: string,
): Promise<T> {
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, effectiveTimeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }

  return DEFAULT_TIMEOUT_MS;
}
